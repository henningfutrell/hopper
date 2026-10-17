// Issue #1736: a read-only check that failed only on a read a right credential refuses (helm list on secrets, on a view
// role) was judged by an older rule. The probes pass it now, so the check pass runs it again, with no person, and the jobs
// that wait on it go on. A check that failed on anything else still waits for a person.
import { describe, expect, it } from 'vitest';
import type { ProbeResult, ReadOnlyCheck } from '../../src/domain/read-only-check.ts';
import type { Template } from '../../src/domain/vault.ts';
import { createCheckPass, judgedAgain } from '../../src/sandbox/check.ts';
import { HOPPER_PROBES } from '../../src/sandbox/probes.ts';
import { createFakeContainerRuntime } from '../support/fake-container-runtime.ts';

const T0 = Date.parse('2030-01-01T00:00:00Z');
const IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';
const SECRETS = 'Error: list: failed to list: secrets is forbidden: User "view" cannot list resource "secrets" in API group "" at the cluster scope';
const ok = (id: string, expect: 'allowed' | 'denied'): ProbeResult => ({ id, asset: 'lab', expect, outcome: expect, passed: true, exit: expect === 'allowed' ? 0 : 1, output: '' });
const helmList = (output: string, outcome: ProbeResult['outcome'] = 'denied'): ProbeResult => ({ id: 'helm.list', asset: 'lab', expect: 'allowed', outcome, passed: false, exit: 1, output });

function template(probes: ProbeResult[], extra: Partial<ReadOnlyCheck> = {}): Template {
  const savedAt = new Date(T0 - 1000).toISOString();
  return {
    name: 'asked-0123456789ab', image: IMAGE, secrets: [], profiles: [{ operation: 'read', asset: { kind: 'cluster', name: 'lab' } }],
    readOnly: true, savedBy: 'job j', savedAt,
    approval: { image: IMAGE, secrets: [], by: 'the read policy', at: new Date(T0).toISOString() },
    check: { version: savedAt, state: 'failed', at: new Date(T0).toISOString(), probes, ...extra },
  };
}

const failedOnHelmList = (output = SECRETS, outcome?: ProbeResult['outcome']): Template =>
  template([ok('kube.get', 'allowed'), ok('kube.create-namespace', 'denied'), helmList(output, outcome)]);

describe('a check that failed only on a read a right credential refuses (issue #1736)', () => {
  it('the probes judge it again: helm list refused on secrets passes now', () => {
    expect(judgedAgain(failedOnHelmList(), HOPPER_PROBES)).toBe(true);
  });

  it('a refusal on anything else, an error, a write that went through, or a problem: it still waits for a person', () => {
    expect(judgedAgain(failedOnHelmList('configmaps is forbidden'), HOPPER_PROBES)).toBe(false);
    expect(judgedAgain(failedOnHelmList('Error: Kubernetes cluster unreachable', 'error'), HOPPER_PROBES)).toBe(false);
    const wrote: ProbeResult = { id: 'kube.create-namespace', asset: 'lab', expect: 'denied', outcome: 'allowed', passed: false, exit: 0, output: 'created' };
    expect(judgedAgain(template([wrote, helmList(SECRETS)]), HOPPER_PROBES)).toBe(false);
    expect(judgedAgain(template([helmList(SECRETS)], { problem: 'the check box ended with 1' }), HOPPER_PROBES)).toBe(false);
    expect(judgedAgain(template([], { problem: 'no minting credential' }), HOPPER_PROBES)).toBe(false);
    const passed = failedOnHelmList();
    expect(judgedAgain({ ...passed, check: { ...passed.check!, state: 'passed' } }, HOPPER_PROBES)).toBe(false);
  });

  it('the check pass runs it again, once', async () => {
    let t = failedOnHelmList();
    let asked = 0;
    const runtime = createFakeContainerRuntime();
    const pass = createCheckPass({
      local: runtime, place: async () => ({ machine: 'local', runtime, network: 'n' }), instanceId: 'i', probes: HOPPER_PROBES,
      clock: { now: () => new Date(T0 + 60_000) }, logger: { info: () => {}, warn: () => {} },
      credentials: { credential: async () => { asked++; return { refused: 'no minting credential' }; } },
    }, {
      templates: () => [{ userId: 'u', template: t }],
      record: async (_u, _n, check: ReadOnlyCheck) => { t = { ...t, check }; },
      credential: async () => ({ refused: 'unused' }),
      report: async () => undefined,
    });
    await pass();
    expect(asked).toBe(1);
    // It ran again and failed on its credential: that waits for a person, so the next pass does not run it.
    await pass();
    expect(asked).toBe(1);
  });
});
