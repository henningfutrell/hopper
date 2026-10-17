// Issue #849: a read-only box's egress. Before, a read-only box and its check box ran on the hopper's network and reached
// any host. Now, beside the hopper with the egress set, they join an internal network and reach out only through the
// egress proxy, which allows AWS, the clusters the vault minted for and nothing else; the hopper writes the allowlist and a
// box starts only once the proxy took it. The read-only check proves it with the egress probes: a host off the allowlist,
// past the proxy and through it, must not be reached.
//
// Feature: a read-only box reaches out only to the allowlist
//   Scenario: the allowlist is AWS's endpoints, each cluster's API server and an STS endpoint that is not AWS's
//   Scenario: a box waits until the proxy took the allowlist; one the proxy never takes fails the box
//   Scenario: a read-only need box joins the internal network with the proxy's variables; a write box does not
//   Scenario: the check box joins it too, and the egress probes pass only when the host off the allowlist is not reached
//   Scenario: the egress variables are set together, or none is
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReadOnlyCheck } from '../../src/domain/read-only-check.ts';
import type { Template } from '../../src/domain/vault.ts';
import { createCheckPass } from '../../src/sandbox/check.ts';
import { allowlist, createEgress, egressHosts, type Egress } from '../../src/sandbox/egress.ts';
import { EGRESS_PROBES, HOPPER_PROBES } from '../../src/sandbox/probes.ts';
import { createPlacements } from '../../src/sandbox/runtime.ts';
import { createSandboxes } from '../../src/sandbox/service.ts';
import { egressProblem } from '../../src/sandbox/settings.ts';
import { createFakeCloudTools, type EgressMode, type FakeCloudTools } from '../support/fake-cloud-tools.ts';
import { createFakeContainerRuntime } from '../support/fake-container-runtime.ts';

const dirs: string[] = [];
const fakes: FakeCloudTools[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const f of fakes.splice(0)) f.cleanup();
});
const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'hopper-egress-'));
  dirs.push(d);
  return d;
};

/** The egress proxy's side of the handshake: it takes each new version, as the compose service does. */
function proxyTakes(dir: string): () => void {
  const timer = setInterval(() => {
    try { writeFileSync(join(dir, 'loaded'), readFileSync(join(dir, 'version'), 'utf8')); } catch { /* not written yet */ }
  }, 5);
  return () => clearInterval(timer);
}

describe('the allowlist (issue #849)', () => {
  it('is AWS\'s endpoints, each cluster\'s API server and an STS endpoint that is not AWS\'s', () => {
    const hosts = egressHosts([
      { kind: 'kube', server: 'https://10.0.0.5:6443' },
      { kind: 'kube', server: 'https://ABC.gr7.us-east-1.eks.amazonaws.com' },
      { kind: 'aws', region: 'us-east-1' },
      { kind: 'aws', region: 'us-east-1', stsEndpoint: 'https://sts.internal.example:8443' },
    ]);
    expect(hosts).toEqual([{ host: '10.0.0.5', port: 6443 }, { host: 'sts.internal.example', port: 8443 }]);
    const list = allowlist(hosts);
    expect(list.filter.split('\n').filter(Boolean)).toEqual(['^([a-z0-9-]+\\.)*amazonaws\\.com$', '^10\\.0\\.0\\.5$', '^sts\\.internal\\.example$']);
    expect(list.ports).toBe('443\n6443\n8443\n');
    // The filter is what tinyproxy matches each CONNECT's host against.
    const filter = list.filter.split('\n').filter(Boolean).map((r) => new RegExp(r));
    const allowed = (host: string): boolean => filter.some((r) => r.test(host));
    expect(['sts.amazonaws.com', 's3.eu-west-1.amazonaws.com', '10.0.0.5', 'sts.internal.example'].every(allowed)).toBe(true);
    expect(['example.com', 'amazonaws.com.example.com', 'evilamazonaws.com', '10.0.0.50', 'registry.terraform.io'].some(allowed)).toBe(false);
    expect(allowlist([]).version).not.toBe(list.version);
    expect(allowlist(hosts).version).toBe(list.version);
  });
});

describe('the handshake with the egress proxy (issue #849)', () => {
  it('a box waits until the proxy took the allowlist; one the proxy never takes fails the box', async () => {
    const dir = tempDir();
    const egress = createEgress({ network: 'hopper_egress', proxy: 'http://egress:3128', dir }, { waitMs: 200, pollMs: 5 });
    await expect(egress.allow([{ kind: 'kube', server: 'https://k:6443' }])).rejects.toThrow(/the egress proxy did not take the allowlist/);
    expect(readFileSync(join(dir, 'filter'), 'utf8')).toContain('^k$');

    const stop = proxyTakes(dir);
    try {
      await egress.allow([{ kind: 'kube', server: 'https://other:443' }]);
      // The allowlist only grows while the hopper runs: the first box's cluster stays.
      expect(readFileSync(join(dir, 'filter'), 'utf8').split('\n')).toEqual(expect.arrayContaining(['^k$', '^other$']));
      expect(readFileSync(join(dir, 'ports'), 'utf8')).toBe('443\n6443\n');
      expect(readFileSync(join(dir, 'loaded'), 'utf8').trim()).toBe(readFileSync(join(dir, 'version'), 'utf8').trim());
    } finally {
      stop();
    }
    expect(egress.env).toMatchObject({ HTTPS_PROXY: 'http://egress:3128', https_proxy: 'http://egress:3128', NO_PROXY: 'hopper,localhost,127.0.0.1' });
  });
});

/** The sandbox module with the egress set, its runtime a double, and the proxy taking each allowlist. */
function sandboxesWith(egress: Egress) {
  const runtime = createFakeContainerRuntime();
  runtime.runScript = async () => ({ exit: 0, output: '' });
  const dir = tempDir();
  const sandboxes = createSandboxes({
    runtime, repo: { list: () => [], remove: () => true },
    runs: { start: () => {}, end: () => {}, destroyed: () => {}, open: () => [], latest: () => [] } as never,
    instanceId: 'i', network: 'hopper_default', egress, clock: { now: () => new Date() }, logger: { info: () => {}, warn: () => {} },
  });
  const step = (readOnly: boolean) => sandboxes.needStep('u1', {
    name: `hopper-need-${readOnly ? 'read' : 'write'}`, template: { image: 'img', ...(readOnly ? { readOnly: true } : {}) },
    env: { HOPPER_STEP_COMMAND: 'true' }, reaches: [{ kind: 'kube', server: 'https://10.0.0.5:6443' }], timeoutMs: 5000, dir,
  }, { log: () => {}, signal: new AbortController().signal, pollMs: 5 }, { jobId: 'job-1', step: `s-${readOnly}`, template: 't' });
  return { runtime, step };
}

describe('a read-only need box (issue #849)', () => {
  it('joins the internal network with the proxy\'s variables; a write box does not', async () => {
    const dir = tempDir();
    const stop = proxyTakes(dir);
    try {
      const s = sandboxesWith(createEgress({ network: 'hopper_egress', proxy: 'http://egress:3128', dir }, { pollMs: 5 }));
      expect(await s.step(true)).toMatchObject({ exit: 0 });
      expect(await s.step(false)).toMatchObject({ exit: 0 });
      const [read, write] = [...s.runtime.ran.values()];
      expect(read).toMatchObject({ name: 'hopper-need-read', network: 'hopper_egress', env: { HOPPER_STEP_COMMAND: 'true', HTTPS_PROXY: 'http://egress:3128', NO_PROXY: 'hopper,localhost,127.0.0.1' } });
      expect(write).toMatchObject({ name: 'hopper-need-write', network: 'hopper_default' });
      expect(write!.env.HTTPS_PROXY).toBeUndefined();
      expect(readFileSync(join(dir, 'filter'), 'utf8')).toContain('^10\\.0\\.0\\.5$');
    } finally {
      stop();
    }
  });

  it('does not start when the proxy does not take its allowlist', async () => {
    const s = sandboxesWith(createEgress({ network: 'hopper_egress', proxy: 'http://egress:3128', dir: tempDir() }, { waitMs: 50, pollMs: 5 }));
    const r = await s.step(true);
    expect(r).toMatchObject({ exit: 125 });
    expect(r.problem).toMatch(/the egress proxy did not take the allowlist/);
    expect(s.runtime.ran.size).toBe(0);
  });
});

const IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';

/** One check of a read-only template with one cluster and one AWS role, the egress as `mode` lets out. */
async function checkWith(mode: EgressMode, o: { egress?: boolean } = {}) {
  const cloud = createFakeCloudTools('read-only');
  fakes.push(cloud);
  cloud.setEgress(mode);
  const runtime = createFakeContainerRuntime();
  runtime.runScript = (spec) => cloud.runScript(spec);
  const dir = tempDir();
  mkdirSync(dir, { recursive: true });
  const stop = proxyTakes(dir);
  const egress = o.egress === false ? undefined : createEgress({ network: 'hopper_egress', proxy: 'http://egress:3128', dir }, { pollMs: 5 });
  let template: Template = {
    name: 'asked-0123456789ab', image: IMAGE, secrets: [], readOnly: true, savedBy: 'job j', savedAt: '2030-01-01T00:00:00.000Z',
    profiles: [{ operation: 'read', asset: { kind: 'cluster', name: 'lab' } }, { operation: 'read', asset: { kind: 'aws-role', name: 'acct/read' } }],
    approval: { image: IMAGE, secrets: [], by: 'the read policy', at: '2030-01-01T00:00:01.000Z' },
  };
  const places = createPlacements({ local: runtime, network: 'hopper_default', ...(egress ? { egress } : {}) });
  const pass = createCheckPass({
    place: places.forCheck, instanceId: 'i', probes: HOPPER_PROBES, clock: { now: () => new Date('2030-01-01T00:01:00Z') },
    logger: { info: () => {}, warn: () => {} },
    credentials: {
      credential: async (_u, _t, _c, profile) => (profile.asset.kind === 'cluster'
        ? { minted: { kind: 'kube', token: 't', expirationTimestamp: '2030-01-01T00:10:00Z' }, reach: { kind: 'kube', server: 'https://10.0.0.5:6443' } }
        : { minted: { kind: 'aws', AccessKeyId: 'AKIA', SecretAccessKey: 's', SessionToken: 'st', Expiration: '2030-01-01T00:10:00Z' }, reach: { kind: 'aws', region: 'us-east-1' } }),
    },
  }, {
    templates: () => [{ userId: 'u', template }],
    record: async (_u, _n, check) => { template = { ...template, check }; },
    credential: async () => ({ refused: 'unused' }),
    report: async () => undefined,
  });
  try {
    await pass();
  } finally {
    stop();
  }
  const check = template.check as ReadOnlyCheck;
  return { check, egressProbes: check.probes.filter((p) => p.id.startsWith('egress.')).sort((a, b) => a.id.localeCompare(b.id)), box: [...runtime.ran.values()][0], dir };
}

describe('the read-only check box (issue #849)', () => {
  it('joins the internal network behind the proxy, and its egress probes pass: the host off the allowlist is not reached', async () => {
    const { check, egressProbes, box, dir } = await checkWith('limited');
    expect(box).toMatchObject({ network: 'hopper_egress', env: { HTTPS_PROXY: 'http://egress:3128' } });
    expect(readFileSync(join(dir, 'filter'), 'utf8')).toContain('^10\\.0\\.0\\.5$');
    // Once per check, not per asset.
    expect(egressProbes.map((p) => [p.id, p.outcome, p.passed])).toEqual([['egress.aws', 'denied', true], ['egress.kube', 'denied', true]]);
    expect(egressProbes[0]!.output).toContain('through the proxy (exit 255): aws: [ERROR]: Failed to connect to proxy URL: "http://egress:3128"');
    expect(egressProbes[1]!.output).toContain('past the proxy (exit 1): Unable to connect to the server: dial tcp');
    expect(check.state).toBe('passed');
  });

  it('fails when a box reaches the host, past the proxy or through it', async () => {
    for (const mode of ['open', 'proxy-open'] as const) {
      const { check, egressProbes } = await checkWith(mode);
      expect(egressProbes.map((p) => [p.id, p.outcome, p.passed])).toEqual([['egress.aws', 'allowed', false], ['egress.kube', 'allowed', false]]);
      expect(check.state).toBe('failed');
    }
  });

  it('with no egress set the box joins the hopper\'s network, and the probes still run', async () => {
    const { box, egressProbes } = await checkWith('limited', { egress: false });
    expect(box).toMatchObject({ network: 'hopper_default' });
    expect(box!.env.HTTPS_PROXY).toBeUndefined();
    expect(egressProbes.map((p) => p.passed)).toEqual([true, true]);
  });

  it('the egress probes send no credential of the check', () => {
    for (const p of EGRESS_PROBES) expect(p.script).not.toMatch(/\$c\d|KUBECONFIG=|AWS_SESSION_TOKEN=/);
    expect(EGRESS_PROBES.find((p) => p.id === 'egress.aws')!.script).toContain('env -u AWS_SESSION_TOKEN -u AWS_PROFILE');
    expect(EGRESS_PROBES.find((p) => p.id === 'egress.kube')!.script).toContain('--kubeconfig=/dev/null');
  });
});

describe('the egress variables (issue #849)', () => {
  it('are set together, or none is', () => {
    expect(egressProblem({})).toBeUndefined();
    expect(egressProblem({ HOPPER_SANDBOX_EGRESS_NETWORK: 'n', HOPPER_SANDBOX_EGRESS_PROXY: 'http://p:1', HOPPER_SANDBOX_EGRESS_DIR: '/d' })).toBeUndefined();
    expect(egressProblem({ HOPPER_SANDBOX_EGRESS_NETWORK: 'n' })).toBe('HOPPER_SANDBOX_EGRESS_PROXY and HOPPER_SANDBOX_EGRESS_DIR must be set with HOPPER_SANDBOX_EGRESS_NETWORK');
  });
});
