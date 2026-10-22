// Issue #2146 (the bastion path, part 5): the read-only check under observe. A template whose needs change no asset — a
// read or an observe — takes the read-only check, and its bastion waits for it. For an observe need the vault mints the
// observe credential for the check box, as for the bastion, and the probes under it show it reads and changes nothing:
// the reads work, each write is refused, and `pods/exec` (by its create and its get) and a Secret read (a list and a get)
// are refused. The pass with the runtime as a double whose one-shot boxes run the check's real script with fake tools.
//
// Feature: the read-only check under observe
//   Scenario: the catalog runs the kube probes, exec and a Secret read under an observe need, and no helm or AWS probe
//   Scenario: a read need gets neither the exec nor the Secret probe
//   Scenario: an observe credential that reads and changes nothing passes; the observe credential is the one minted
//   Scenario: an observe credential that may exec and read Secrets fails, and the failure says it is under observe
//   Scenario: a credential the cluster does not take errs on exec and the Secret read, and is never reported allowed (issue #2396)
//   Scenario: one request refused and the other erred is an error, not a refusal (issue #2396)
//   Scenario: a view role that may get pods/exec but not create it is refused exec: the get is a WebSocket upgrade (issue #2477)
//   Scenario: a read and an observe on one asset each get their own credential and their own probes
import { afterEach, describe, expect, it } from 'vitest';
import type { OperationProfile } from '../../src/domain/access.ts';
import { failedProbes, type ReadOnlyCheck } from '../../src/domain/read-only-check.ts';
import type { Template } from '../../src/domain/vault.ts';
import { createCheckPass } from '../../src/sandbox/check.ts';
import { HOPPER_PROBES } from '../../src/sandbox/probes.ts';
import { createFakeCloudTools, type CloudMode, type FakeCloudTools } from '../support/fake-cloud-tools.ts';
import { createFakeContainerRuntime } from '../support/fake-container-runtime.ts';

const fakes: FakeCloudTools[] = [];
afterEach(() => { for (const f of fakes.splice(0)) f.cleanup(); });

const IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';
const OBSERVE: OperationProfile = { operation: 'observe', asset: { kind: 'namespace', name: 'uat/monitoring' } };
const READ: OperationProfile = { operation: 'read', asset: { kind: 'namespace', name: 'uat/monitoring' } };
const minted = (token: string) => ({ minted: { kind: 'kube' as const, token, expirationTimestamp: '2030-01-01T00:10:00Z' }, reach: { kind: 'kube' as const, server: 'https://k' } });

function setup(profiles: OperationProfile[], mode: CloudMode = 'read-only') {
  const cloud = createFakeCloudTools(mode);
  fakes.push(cloud);
  const runtime = createFakeContainerRuntime();
  runtime.runScript = (spec) => cloud.runScript(spec);
  const asked: OperationProfile[] = [];
  let template: Template = {
    name: 'asked-0123456789ab', image: IMAGE, secrets: [], tools: ['kubectl'], profiles, readOnly: true,
    savedBy: 'job j', savedAt: '2030-01-01T00:00:00.000Z', approval: { image: IMAGE, tools: ['kubectl'], secrets: [], by: 'a person', at: '2030-01-01T00:00:01.000Z' },
  };
  const pass = createCheckPass({
    local: runtime, place: async () => ({ machine: 'local', runtime, network: 'n' }), instanceId: 'i', probes: HOPPER_PROBES,
    clock: { now: () => new Date('2030-01-01T00:01:00Z') }, logger: { info: () => {}, warn: () => {} },
    credentials: { credential: async (_u: string, _t: string, _c: string, need: OperationProfile) => { asked.push(need); return minted(`${need.operation}-token`); } },
  }, {
    templates: () => [{ userId: 'u', template }],
    record: async (_u, _n, check: ReadOnlyCheck) => { template = { ...template, check }; },
    credential: async () => ({ refused: 'unused' }),
    report: async () => undefined,
  });
  return { pass, runtime, cloud, asked, check: () => template.check! };
}

const ids = (needs: OperationProfile[]) => HOPPER_PROBES.runsFor(needs).map((r) => `${r.probe.id}${r.operation ? ` ${r.operation}` : ''}`);

describe('the read-only check under observe (issue #2146, part 5)', () => {
  it('the catalog runs the kube probes, exec and a Secret read under an observe need, and no helm or AWS probe', () => {
    expect(ids([OBSERVE])).toEqual([
      'kube.get observe', 'kube.create-namespace observe', 'kube.delete-pod observe', 'observe.exec observe', 'observe.secret-read observe', 'egress.kube observe',
    ]);
  });

  it('a read need gets neither the exec nor the Secret probe', () => {
    const read = ids([READ]);
    expect(read).toContain('kube.get');
    expect(read).toContain('helm.list');
    expect(read.some((id) => id.startsWith('observe.'))).toBe(false);
  });

  it('an observe credential that reads and changes nothing passes; the observe credential is the one minted', async () => {
    const s = setup([OBSERVE]);
    await s.pass();
    const check = s.check();
    expect(check.state, JSON.stringify(check)).toBe('passed');
    expect(s.asked).toEqual([OBSERVE]);
    expect(check.probes.every((p) => p.operation === 'observe')).toBe(true);
    expect(check.probes.find((p) => p.id === 'observe.exec')).toMatchObject({ expect: 'denied', outcome: 'denied', passed: true });
    expect(check.probes.find((p) => p.id === 'observe.secret-read')).toMatchObject({ expect: 'denied', outcome: 'denied', passed: true });
    // Exec is tried by its create and by its get, and a Secret by a list and a get.
    const calls = s.cloud.calls();
    expect(calls.filter((c) => c.includes('/pods/hopper-read-only-check/exec'))).toHaveLength(2);
    expect(calls.some((c) => c.startsWith('kubectl get secrets -n monitoring'))).toBe(true);
    expect(calls.some((c) => c.startsWith('kubectl get secret hopper-read-only-check -n monitoring'))).toBe(true);
  });

  it('an observe credential that may exec and read Secrets fails, and the failure says it is under observe', async () => {
    const s = setup([OBSERVE], 'writable');
    await s.pass();
    const check = s.check();
    expect(check.state).toBe('failed');
    const failed = failedProbes(check);
    expect(failed).toContain('observe.exec on uat/monitoring under observe (allowed)');
    expect(failed).toContain('observe.secret-read on uat/monitoring under observe (allowed)');
  });

  it('a credential the cluster does not take errs on exec and the Secret read, and is never reported allowed (issue #2396)', async () => {
    const s = setup([OBSERVE], 'unauthorized');
    await s.pass();
    const check = s.check();
    expect(check.state).toBe('failed');
    for (const id of ['observe.exec', 'observe.secret-read']) {
      const probe = check.probes.find((p) => p.id === id);
      expect(probe, id).toMatchObject({ expect: 'denied', outcome: 'error', passed: false });
      expect(probe!.output).toContain('Unauthorized');
    }
    expect(failedProbes(check)).toContain('observe.exec on uat/monitoring under observe (error)');
  });

  it('one request refused and the other erred is an error, not a refusal (issue #2396)', async () => {
    const s = setup([OBSERVE], 'get-unauthorized');
    await s.pass();
    const check = s.check();
    expect(check.state).toBe('failed');
    const exec = check.probes.find((p) => p.id === 'observe.exec');
    // Its create is Forbidden, its get errs: the probe proves no refusal of both.
    expect(exec).toMatchObject({ outcome: 'error', passed: false });
    expect(exec!.output).toMatch(/Forbidden/);
  });

  it('a view role that may get pods/exec but not create it is refused exec: the get is a WebSocket upgrade (issue #2477)', async () => {
    const s = setup([OBSERVE], 'view-exec');
    await s.pass();
    const check = s.check();
    expect(check.state, JSON.stringify(check)).toBe('passed');
    const exec = check.probes.find((p) => p.id === 'observe.exec');
    expect(exec).toMatchObject({ outcome: 'denied', passed: true });
    expect(exec!.output).toContain('cannot create resource \\"pods/exec\\"');
    // The get goes as kubectl exec sends it: an upgrade to a WebSocket, with the kubeconfig's server and token.
    const upgrade = s.cloud.calls().find((c) => c.startsWith('curl '));
    expect(upgrade).toContain('Upgrade: websocket');
    expect(upgrade).toContain('https://k/api/v1/namespaces/monitoring/pods/hopper-read-only-check/exec?');
    expect(upgrade).not.toContain('observe-token');
  });

  it('a read and an observe on one asset each get their own credential and their own probes', async () => {
    const s = setup([READ, OBSERVE]);
    await s.pass();
    const check = s.check();
    expect(check.state, JSON.stringify(check)).toBe('passed');
    expect(s.asked).toEqual([READ, OBSERVE]);
    expect(check.probes.filter((p) => p.id === 'kube.get').map((p) => p.operation ?? 'read')).toEqual(['read', 'observe']);
    expect(check.probes.filter((p) => p.id === 'observe.exec')).toHaveLength(1);
    const [spec] = [...s.runtime.ran.values()];
    expect(Object.keys(spec!.env).sort()).toEqual(['HOPPER_CHECK_0_KUBECONFIG', 'HOPPER_CHECK_1_KUBECONFIG']);
    // Each probe runs with the kubeconfig of its own need.
    const script = spec!.script ?? '';
    expect(script).toMatch(/# kube\.get on uat\/monitoring\n[\s\S]*?KUBECONFIG="\$HOME\/c0\/kubeconfig"/);
    expect(script).toMatch(/# observe\.exec on uat\/monitoring under observe\n[\s\S]*?KUBECONFIG="\$HOME\/c1\/kubeconfig"/);
  });
});
