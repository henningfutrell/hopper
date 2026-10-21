// Issue #1468: a read-only check that fails only because a mint met a network error (ECONNRESET, a timeout) is marked
// transient, and the check pass runs it again after `CHECK_RETRY_MS`, with no person. A check that fails for any other
// reason still waits for a person.
import { describe, expect, it } from 'vitest';
import type { ReadOnlyCheck } from '../../src/domain/read-only-check.ts';
import { checkWait } from '../../src/domain/read-only-check.ts';
import type { Template } from '../../src/domain/vault.ts';
import { CHECK_RETRY_MS, createCheckPass, dueForCheck } from '../../src/sandbox/check.ts';
import { HOPPER_PROBES } from '../../src/sandbox/probes.ts';
import { createFakeContainerRuntime } from '../support/fake-container-runtime.ts';

const T0 = Date.parse('2030-01-01T00:00:00Z');
const IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';

function setup(refusals: string[]) {
  let now = T0;
  const runtime = createFakeContainerRuntime();
  let template: Template = {
    name: 'asked-0123456789ab', image: IMAGE, secrets: [], profiles: [{ operation: 'read', asset: { kind: 'aws-role', name: '123456789012/ReadOnly' } }],
    readOnly: true, savedBy: 'job j', savedAt: new Date(T0 - 1000).toISOString(),
    approval: { image: IMAGE, secrets: [], by: 'the read policy', at: new Date(T0).toISOString() },
  };
  let asked = 0;
  const pass = createCheckPass({
    local: runtime, place: async () => ({ machine: 'local', runtime, network: 'n' }), instanceId: 'i', probes: HOPPER_PROBES, clock: { now: () => new Date(now) }, logger: { info: () => {}, warn: () => {} },
    credentials: { credential: async () => { asked++; return { refused: refusals.shift() ?? 'no more' }; } },
  }, {
    templates: () => [{ userId: 'u', template }],
    record: async (_u, _n, check: ReadOnlyCheck) => { template = { ...template, check }; },
    credential: async () => ({ refused: 'unused' }),
    report: async () => undefined,
  });
  return { pass, at: (ms: number) => { now = T0 + ms; }, template: () => template, asked: () => asked };
}

describe('a read-only check that fails on a network error (issue #1468)', () => {
  it('is marked transient, says it runs again, and runs again after CHECK_RETRY_MS with no person', async () => {
    const s = setup(['STS answered: read ECONNRESET']);
    await s.pass();
    expect(s.template().check).toMatchObject({ state: 'failed', transient: true });
    expect(checkWait(s.template())).toContain('a network error');
    // Issue #1779: a network error is no standing refusal to mint.
    expect(s.template().check!.unminted).toBeUndefined();
    expect(dueForCheck(s.template(), new Date(T0 + CHECK_RETRY_MS - 1))).toBe(false);
    expect(dueForCheck(s.template(), new Date(T0 + CHECK_RETRY_MS))).toBe(true);
    s.at(CHECK_RETRY_MS);
    await s.pass();
    expect(s.asked()).toBe(2);
  });

  it('a timeout is transient too', async () => {
    const s = setup(['STS answered: connect ETIMEDOUT 1.2.3.4:443']);
    await s.pass();
    expect(s.template().check).toMatchObject({ state: 'failed', transient: true });
  });

  it('any other failure waits for a person', async () => {
    const s = setup(['no minting credential mints for aws-account 123456789012: a person adds one on Vault']);
    await s.pass();
    expect(s.template().check).toMatchObject({ state: 'failed' });
    expect(s.template().check!.transient).toBeUndefined();
    // Issue #1779: the need the vault minted nothing for, kept with its reason.
    expect(s.template().check!.unminted).toEqual([{ asset: { kind: 'aws-role', name: '123456789012/ReadOnly' }, reason: expect.stringContaining('no minting credential mints for aws-account') }]);
    expect(dueForCheck(s.template(), new Date(T0 + 10 * CHECK_RETRY_MS))).toBe(false);
    expect(checkWait(s.template())).toContain('A person runs it again');
  });
});
