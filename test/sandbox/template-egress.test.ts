// Issue #1875: a template's egress hosts. A need box of a template that names egress hosts joins the internal network
// behind the egress proxy, as a read-only box does (issue #849), and the proxy allows those hosts too before the box
// starts. A write box of a template with no egress hosts keeps the hopper's network.
//
// Feature: a box reaches the egress hosts its template names
//   Scenario: a write box of a template with an egress host joins the internal network, and the proxy allows the host
//   Scenario: a read-only box's template hosts join its clusters on the allowlist
//   Scenario: an egress host is host:port, a DNS name or an address, nothing else
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { egressHostProblem } from '../../src/domain/vault.ts';
import { createEgress } from '../../src/sandbox/egress.ts';
import { createSandboxes } from '../../src/sandbox/service.ts';
import { createFakeContainerRuntime } from '../support/fake-container-runtime.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tempDir = (): string => { const d = mkdtempSync(join(tmpdir(), 'hopper-egress-')); dirs.push(d); return d; };

/** The egress proxy's side of the handshake: it takes each new version, as the compose service does. */
function proxyTakes(dir: string): () => void {
  const timer = setInterval(() => {
    try { writeFileSync(join(dir, 'loaded'), readFileSync(join(dir, 'version'), 'utf8')); } catch { /* not written yet */ }
  }, 5);
  return () => clearInterval(timer);
}

function stepOf(proxyDir: string) {
  const runtime = createFakeContainerRuntime();
  runtime.runScript = async () => ({ exit: 0, output: '' });
  const dir = tempDir();
  const sandboxes = createSandboxes({
    runtime, repo: { list: () => [], remove: () => true },
    runs: { start: () => {}, end: () => {}, destroyed: () => {}, open: () => [], latest: () => [] } as never,
    instanceId: 'i', network: 'hopper_default', egress: createEgress({ network: 'hopper_egress', proxy: 'http://egress:3128', dir: proxyDir }, { pollMs: 5 }),
    clock: { now: () => new Date() }, logger: { info: () => {}, warn: () => {} },
  });
  const step = (name: string, template: { readOnly?: true; egress?: string[] }) => sandboxes.needStep('u1', {
    name, template: { image: 'img', ...template }, env: { HOPPER_STEP_COMMAND: 'true' },
    reaches: [{ kind: 'kube', server: 'https://10.0.0.5:6443' }], timeoutMs: 5000, dir,
  }, { log: () => {}, signal: new AbortController().signal, pollMs: 5 }, { jobId: 'job-1', step: `s-${name}`, template: 't' });
  return { runtime, step };
}

describe('a box of a template with egress hosts (issue #1875)', () => {
  it('joins the internal network behind the proxy, which allows its hosts; a write box with none keeps the hopper\'s network', async () => {
    const proxyDir = tempDir();
    const stop = proxyTakes(proxyDir);
    try {
      const s = stepOf(proxyDir);
      expect(await s.step('hopper-need-e2e', { egress: ['auth.example.test:443', 'idp.example.test:8443'] })).toMatchObject({ exit: 0 });
      expect(await s.step('hopper-need-open', {})).toMatchObject({ exit: 0 });
      const [e2e, open] = [...s.runtime.ran.values()];
      expect(e2e).toMatchObject({ network: 'hopper_egress', env: { HTTPS_PROXY: 'http://egress:3128', NO_PROXY: 'hopper,localhost,127.0.0.1' } });
      expect(open).toMatchObject({ network: 'hopper_default' });
      const filter = readFileSync(join(proxyDir, 'filter'), 'utf8').split('\n');
      expect(filter).toEqual(expect.arrayContaining(['^auth\\.example\\.test$', '^idp\\.example\\.test$']));
      // The step's cluster (6443) and the template's hosts' ports.
      expect(readFileSync(join(proxyDir, 'ports'), 'utf8')).toBe('443\n6443\n8443\n');
    } finally {
      stop();
    }
  });

  it('a read-only box\'s template hosts join its clusters on the allowlist', async () => {
    const proxyDir = tempDir();
    const stop = proxyTakes(proxyDir);
    try {
      expect(await stepOf(proxyDir).step('hopper-need-read', { readOnly: true, egress: ['auth.example.test:443'] })).toMatchObject({ exit: 0 });
      expect(readFileSync(join(proxyDir, 'filter'), 'utf8').split('\n')).toEqual(expect.arrayContaining(['^10\\.0\\.0\\.5$', '^auth\\.example\\.test$']));
    } finally {
      stop();
    }
  });
});

describe('an egress host (issue #1875)', () => {
  it('is host:port, a DNS name or an address, nothing else', () => {
    for (const ok of ['auth.example.test:443', '10.0.0.5:8443', 'localhost-ish:1', 'a.b-c.d:65535']) expect(egressHostProblem(ok), ok).toBeUndefined();
    for (const bad of ['auth.example.test', 'https://a.test:443', 'a.test:0', 'a.test:65536', '*.a.test:443', 'a b:443', ':443', 'a.test:44x', '-a.test:443', 'a..test:443', 'A.test:443'])
      expect(egressHostProblem(bad), bad).toMatch(/egress host/);
  });
});
