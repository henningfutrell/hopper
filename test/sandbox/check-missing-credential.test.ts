// Issue #873: when one read need of a template gets no credential, the read-only check still runs the probes of the other
// needs in its check box. Each probe of the need with no credential is not run, and says why; the check fails. Before, the
// check failed with one problem for all needs, and no probe ran. The pass with the runtime as a double whose one-shot boxes
// run the check's real script with fake tools.
//
// Feature: a need with no credential in the read-only check
//   Scenario: the probes of the need with a credential run; those of the need with none are not run, each with its reason
//   Scenario: with no need given a credential, no check box runs, and each probe says why it is not run
//   Scenario: only network errors left needs with no credential, and every probe that ran passed: the check is transient
import { afterEach, describe, expect, it } from 'vitest';
import type { OperationProfile } from '../../src/domain/access.ts';
import type { ReadOnlyCheck } from '../../src/domain/read-only-check.ts';
import type { Template } from '../../src/domain/vault.ts';
import { createCheckPass } from '../../src/sandbox/check.ts';
import { HOPPER_PROBES } from '../../src/sandbox/probes.ts';
import { createFakeCloudTools, type FakeCloudTools } from '../support/fake-cloud-tools.ts';
import { createFakeContainerRuntime } from '../support/fake-container-runtime.ts';

const fakes: FakeCloudTools[] = [];
afterEach(() => { for (const f of fakes.splice(0)) f.cleanup(); });

const IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';
const MINTED = { minted: { kind: 'kube' as const, token: 't', expirationTimestamp: '2030-01-01T00:10:00Z' }, reach: { kind: 'kube' as const, server: 'https://k' } };

/** A template that reads clusters `lab` and `other`; `refused` names the clusters the vault gives no credential, and why. */
function setup(refused: Record<string, string>) {
  const cloud = createFakeCloudTools('read-only');
  fakes.push(cloud);
  const runtime = createFakeContainerRuntime();
  runtime.runScript = (spec) => cloud.runScript(spec);
  let template: Template = {
    name: 'asked-0123456789ab', image: IMAGE, secrets: [],
    profiles: [{ operation: 'read', asset: { kind: 'cluster', name: 'lab' } }, { operation: 'read', asset: { kind: 'cluster', name: 'other' } }],
    readOnly: true, savedBy: 'job j', savedAt: '2030-01-01T00:00:00.000Z',
    approval: { image: IMAGE, secrets: [], by: 'the read policy', at: '2030-01-01T00:00:01.000Z' },
  };
  const pass = createCheckPass({
    local: runtime, place: async () => ({ machine: 'local', runtime, network: 'n' }), instanceId: 'i', probes: HOPPER_PROBES,
    clock: { now: () => new Date('2030-01-01T00:01:00Z') }, logger: { info: () => {}, warn: () => {} },
    credentials: { credential: async (_u: string, _t: string, _c: string, need: OperationProfile) => (need.asset.name in refused ? { refused: refused[need.asset.name]! } : MINTED) },
  }, {
    templates: () => [{ userId: 'u', template }],
    record: async (_u, _n, check: ReadOnlyCheck) => { template = { ...template, check }; },
    credential: async () => ({ refused: 'unused' }),
    report: async () => undefined,
  });
  return { pass, runtime, check: () => template.check! };
}

const why = (cluster: string, reason: string): string => `not run: the check box gets no credential for read on cluster ${cluster}: ${reason}`;

describe('a need with no credential in the read-only check (issue #873)', () => {
  it('the probes of the need with a credential run; those of the need with none are not run, each with its reason', async () => {
    const s = setup({ other: 'no minting credential mints for cluster other' });
    await s.pass();
    const check = s.check();
    expect(check.state).toBe('failed');
    expect(check.problem).toBeUndefined();
    expect(check.transient).toBeUndefined();
    const lab = check.probes.filter((p) => p.asset === 'lab');
    const other = check.probes.filter((p) => p.asset === 'other');
    expect(lab.length).toBeGreaterThan(0);
    expect(lab.every((p) => p.passed && p.outcome !== 'not-run'), JSON.stringify(lab)).toBe(true);
    expect(other.length).toBe(lab.length);
    for (const p of other) expect(p).toMatchObject({ outcome: 'not-run', passed: false, output: why('other', 'no minting credential mints for cluster other') });
    expect(s.runtime.ran.size).toBe(1);
    // The check box got only the credential of cluster lab.
    expect(Object.keys([...s.runtime.ran.values()][0]!.env)).toEqual(['HOPPER_CHECK_0_KUBECONFIG']);
  });

  it('with no need given a credential, no check box runs, and each probe says why it is not run', async () => {
    const s = setup({ lab: 'Access denied it', other: 'no minting credential mints for cluster other' });
    await s.pass();
    const check = s.check();
    expect(check.state).toBe('failed');
    for (const p of check.probes) expect(p).toMatchObject({ outcome: 'not-run', passed: false, output: why(p.asset, p.asset === 'lab' ? 'Access denied it' : 'no minting credential mints for cluster other') });
    expect(s.runtime.ran.size).toBe(0);
  });

  it('only network errors left needs with no credential, and every probe that ran passed: the check is transient', async () => {
    const s = setup({ other: 'the Kubernetes API answered: read ECONNRESET' });
    await s.pass();
    expect(s.check()).toMatchObject({ state: 'failed', transient: true });
    expect(s.runtime.ran.size).toBe(1);
  });
});
