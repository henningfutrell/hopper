// Issue #2236: an approved read template got no read-only check for hours, and its jobs waited with no reason. The pass
// ran one check at a time, so a check that did not end held every template after it. Now a check holds only its own
// template: up to `CHECKS_AT_ONCE` checks run at once, each pass starts the due ones that do not run yet, and a due check
// that cannot start now is held with the reason (`CheckTemplates.held`), which its template's wait says.
//
// Feature: a check holds only its own template
//   Scenario: a check that does not end holds no other template: the next pass checks one approved meanwhile
//   Scenario: at most CHECKS_AT_ONCE checks run at once; the next one is held, saying why, and starts when one ends
//   Scenario: with nowhere to run, the template is held, saying why; once a place is there, its check starts
import { describe, expect, it } from 'vitest';
import type { OperationProfile } from '../../src/domain/access.ts';
import { checkWait, type ReadOnlyCheck } from '../../src/domain/read-only-check.ts';
import type { Template } from '../../src/domain/vault.ts';
import { CHECKS_AT_ONCE, createCheckPass, type CheckPlace } from '../../src/sandbox/check.ts';
import { HOPPER_PROBES } from '../../src/sandbox/probes.ts';
import { createFakeContainerRuntime } from '../support/fake-container-runtime.ts';

const T0 = Date.parse('2030-01-01T00:00:00Z');
const IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';
const REFUSED = { refused: 'no minting credential mints for aws-account 123456789012' };

const templateOf = (name: string): Template => ({
  name, image: IMAGE, secrets: [], profiles: [{ operation: 'read', asset: { kind: 'aws-role', name: `123456789012/${name}` } }],
  readOnly: true, savedBy: 'job j', savedAt: new Date(T0 - 1000).toISOString(),
  approval: { image: IMAGE, secrets: [], by: 'the read policy', at: new Date(T0).toISOString() },
});

/** A pass over the templates added: the mint of a template named `asked-hangs…` answers only at `end`; every other mint is refused, which ends its check. */
function setup() {
  const runtime = createFakeContainerRuntime();
  const all = new Map<string, Template>();
  const held = new Map<string, string>();
  const ends: (() => void)[] = [];
  let place: CheckPlace | undefined = { machine: 'local', runtime, network: 'n' };
  const pass = createCheckPass({
    local: runtime, place: async () => place, instanceId: 'i', probes: HOPPER_PROBES,
    clock: { now: () => new Date(T0) }, logger: { info: () => {}, warn: () => {} }, checkMs: 60_000,
    credentials: {
      credential: (_u: string, template: string, _c: string, _p: OperationProfile) =>
        (template.startsWith('asked-hangs') ? new Promise((resolve) => { ends.push(() => resolve(REFUSED)); }) : Promise.resolve(REFUSED)),
    },
  }, {
    templates: () => [...all.values()].map((template) => ({ userId: 'u', template })),
    record: async (_u, name, check: ReadOnlyCheck) => { all.set(name, { ...all.get(name)!, check }); },
    credential: async () => ({ refused: 'unused' }),
    report: async () => undefined,
    held: (_u, name, why) => { if (why) held.set(name, why); else held.delete(name); },
  });
  return {
    pass,
    add: (...names: string[]) => { for (const n of names) all.set(n, templateOf(n)); },
    /** The template as its view shows it: with the reason its due check is held, when it is. */
    template: (name: string) => ({ ...all.get(name)!, ...(held.has(name) ? { checkHeld: held.get(name)! } : {}) }),
    held,
    /** The hanging mints answer: their checks end. */
    end: () => { for (const e of ends.splice(0)) e(); },
    nowhere: (none: boolean) => { place = none ? undefined : { machine: 'local', runtime, network: 'n' }; },
  };
}

/** Lets the checks a pass started come to their mints. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe('a read-only check holds only its own template (issue #2236)', () => {
  it('a check that does not end holds no other template: the next pass checks one approved meanwhile', async () => {
    const s = setup();
    s.add('asked-hangs');
    const first = s.pass();
    await settle();
    expect(s.template('asked-hangs').check).toMatchObject({ state: 'running' });
    expect(checkWait(s.template('asked-hangs'))).toBe('waiting for the read-only check of asked-hangs: it runs now, since 2030-01-01T00:00:00.000Z');

    // Approved (by the read policy) while that check runs: the next pass checks it, and does not wait for the first. A
    // pass ends when every check that runs has, so the test does not wait for this one.
    s.add('asked-later');
    void s.pass();
    await settle();
    expect(s.template('asked-later').check).toMatchObject({ state: 'failed' });
    expect(s.template('asked-hangs').check).toMatchObject({ state: 'running' });

    s.end();
    await first;
    expect(s.template('asked-hangs').check).toMatchObject({ state: 'failed' });
  });

  it(`at most ${CHECKS_AT_ONCE} checks run at once; the next one is held, saying why, and starts when one ends`, async () => {
    const s = setup();
    const hanging = Array.from({ length: CHECKS_AT_ONCE }, (_, n) => `asked-hangs-${n}`);
    s.add(...hanging);
    const first = s.pass();
    await settle();
    s.add('asked-next');
    void s.pass();
    await settle();
    expect(s.template('asked-next').check).toBeUndefined();
    expect(checkWait(s.template('asked-next'))).toBe(`waiting for the read-only check of asked-next: it has not run on this version yet: ${CHECKS_AT_ONCE} other read-only checks run now, and it starts when one of them ends`);

    s.end();
    await first;
    await s.pass();
    expect(s.template('asked-next').check).toMatchObject({ state: 'failed' });
    expect(s.held.size).toBe(0);
  });

  it('with nowhere to run, the template is held, saying why; once a place is there, its check starts', async () => {
    const s = setup();
    s.add('asked-nowhere');
    s.nowhere(true);
    await s.pass();
    expect(s.template('asked-nowhere').check).toBeUndefined();
    expect(checkWait(s.template('asked-nowhere'))).toBe('waiting for the read-only check of asked-nowhere: it has not run on this version yet: no container runtime can run it now: none beside the hopper, and no machine of the user is dialled in with one');

    s.nowhere(false);
    await s.pass();
    expect(s.template('asked-nowhere').check).toMatchObject({ state: 'failed' });
    expect(s.held.size).toBe(0);
  });
});
