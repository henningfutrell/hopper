// Issue #2226: a read-only check that does not end (a mint, a pull or a build that hangs) is failed when its time is up,
// as transient, saying where it stopped, and the check pass goes on to the other templates; the check pass runs it again
// after `CHECK_RETRY_MS`. A check a stopped hopper left `running` runs again, after the templates that have none.
import { describe, expect, it } from 'vitest';
import type { OperationProfile } from '../../src/domain/access.ts';
import type { ReadOnlyCheck } from '../../src/domain/read-only-check.ts';
import type { Template } from '../../src/domain/vault.ts';
import { CHECK_RETRY_MS, createCheckPass, dueForCheck } from '../../src/sandbox/check.ts';
import { HOPPER_PROBES } from '../../src/sandbox/probes.ts';
import { createFakeContainerRuntime } from '../support/fake-container-runtime.ts';

const T0 = Date.parse('2030-01-01T00:00:00Z');
const IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';

const templateOf = (name: string, check?: ReadOnlyCheck): Template => ({
  name, image: IMAGE, secrets: [], profiles: [{ operation: 'read', asset: { kind: 'aws-role', name: `123456789012/${name}` } }],
  readOnly: true, savedBy: 'job j', savedAt: new Date(T0 - 1000).toISOString(),
  approval: { image: IMAGE, secrets: [], by: 'the read policy', at: new Date(T0).toISOString() },
  ...(check ? { check } : {}),
});

/** A pass over `names`: the mint of each need in `hangs` never answers; every other mint is refused, which ends its check. */
function setup(templates: Template[], hangs: string[]) {
  let now = T0;
  const runtime = createFakeContainerRuntime();
  const all = new Map(templates.map((t) => [t.name, t]));
  const asked: string[] = [];
  const released: string[] = [];
  const pass = createCheckPass({
    local: runtime, place: async () => ({ machine: 'local', runtime, network: 'n' }), instanceId: 'i', probes: HOPPER_PROBES,
    clock: { now: () => new Date(now) }, logger: { info: () => {}, warn: () => {} }, checkMs: 50,
    credentials: {
      credential: (_u: string, template: string, _c: string, _p: OperationProfile) => {
        asked.push(template);
        return hangs.includes(template) ? new Promise(() => {}) : Promise.resolve({ refused: 'no minting credential mints for aws-account 123456789012' });
      },
    },
  }, {
    templates: () => [...all.values()].map((template) => ({ userId: 'u', template })),
    record: async (_u, name, check: ReadOnlyCheck) => { all.set(name, { ...all.get(name)!, check }); },
    credential: async () => ({ refused: 'unused' }),
    release: async (_u, check) => { released.push(check); },
    report: async () => undefined,
  });
  return { pass, at: (ms: number) => { now = T0 + ms; }, template: (name: string) => all.get(name)!, asked, released };
}

describe('a read-only check that does not end (issue #2226)', () => {
  it('fails when its time is up, as transient, saying where it stopped, and the pass checks the next template', async () => {
    const s = setup([templateOf('asked-hangs'), templateOf('asked-next')], ['asked-hangs']);
    await s.pass();
    expect(s.template('asked-hangs').check).toMatchObject({ state: 'failed', transient: true, problem: expect.stringMatching(/^the check did not end in \d+ min: it stopped at minting the read credentials$/) });
    expect(s.template('asked-next').check).toMatchObject({ state: 'failed' });
    expect(s.asked).toEqual(['asked-hangs', 'asked-next']);
    // Its check box's mints end with it, though the run never ended.
    expect(s.released).toHaveLength(2);
    // The check pass runs it again, with no person.
    expect(dueForCheck(s.template('asked-hangs'), new Date(T0 + CHECK_RETRY_MS))).toBe(true);
    s.at(CHECK_RETRY_MS);
    await s.pass();
    expect(s.asked).toEqual(['asked-hangs', 'asked-next', 'asked-hangs']);
  });

  it('a check a stopped hopper left running runs again, after the templates with no check', async () => {
    const left: ReadOnlyCheck = { version: new Date(T0 - 1000).toISOString(), state: 'running', at: new Date(T0 - 500).toISOString(), probes: [] };
    const s = setup([templateOf('asked-left', left), templateOf('asked-new')], []);
    await s.pass();
    expect(s.asked).toEqual(['asked-new', 'asked-left']);
    expect(s.template('asked-left').check).toMatchObject({ state: 'failed' });
  });
});
