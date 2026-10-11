// Issue #715: the read-only check runs again on a schedule, not only on a template's first approval. An account or a
// cluster changes under a template: a role gets a write policy, a binding widens. Once a day the check pass runs a
// template's passed check again. While it runs, the template keeps the check that passed, so its boxes and jobs do not
// stop for it. A check that fails replaces it, and the template takes no box and no job until a person runs it again.
// The pass with the container runtime as a double whose one-shot boxes run the check's real script with fake tools.
//
// Feature: the read-only check on a schedule
//   Scenario: a passed check is not run again before a day has passed
//   Scenario: after a day it runs again; the passed check holds while it runs, and a new pass replaces it
//   Scenario: a scheduled check that fails blocks the template
import { afterEach, describe, expect, it } from 'vitest';
import type { ReadOnlyCheck } from '../../src/domain/read-only-check.ts';
import { checkWait } from '../../src/domain/read-only-check.ts';
import type { Template } from '../../src/domain/vault.ts';
import { CHECK_EVERY_MS, createCheckPass, dueForCheck } from '../../src/sandbox/check.ts';
import { HOPPER_PROBES } from '../../src/sandbox/probes.ts';
import { createFakeCloudTools, type FakeCloudTools } from '../support/fake-cloud-tools.ts';
import { createFakeContainerRuntime } from '../support/fake-container-runtime.ts';

const fakes: FakeCloudTools[] = [];
afterEach(() => { for (const f of fakes.splice(0)) f.cleanup(); });

const T0 = Date.parse('2030-01-01T00:00:00Z');
const IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';

function setup() {
  let now = T0;
  const cloud = createFakeCloudTools('read-only');
  fakes.push(cloud);
  const runtime = createFakeContainerRuntime();
  let template: Template = {
    name: 'asked-0123456789ab', image: IMAGE, secrets: [], profiles: [{ operation: 'read', asset: { kind: 'cluster', name: 'lab' } }],
    readOnly: true, savedBy: 'job j', savedAt: new Date(T0 - 1000).toISOString(),
    approval: { image: IMAGE, secrets: [], by: 'the read policy', at: new Date(T0).toISOString() },
  };
  const recorded: ReadOnlyCheck[] = [];
  const seenWhileRunning: (string | undefined)[] = [];
  runtime.runScript = async (spec) => {
    seenWhileRunning.push(checkWait(template));
    return cloud.runScript(spec);
  };
  const pass = createCheckPass({
    runtime, instanceId: 'i', network: 'n', probes: HOPPER_PROBES, clock: { now: () => new Date(now) }, logger: { info: () => {}, warn: () => {} },
    credentials: { credential: async () => ({ minted: { kind: 'kube', token: 't', expirationTimestamp: '2030-01-01T00:10:00Z' }, reach: { kind: 'kube', server: 'https://k' } }) },
  }, {
    templates: () => [{ userId: 'u', template }],
    record: async (_u, _n, check) => { recorded.push(check); template = { ...template, check }; },
    credential: async () => ({ refused: 'unused' }),
  });
  return { pass, cloud, runtime, recorded, seenWhileRunning, at: (ms: number) => { now = T0 + ms; }, template: () => template };
}

describe('the read-only check on a schedule (issue #715)', () => {
  it('a passed check is not run again before a day has passed', async () => {
    const s = setup();
    await s.pass();
    expect(s.template().check).toMatchObject({ state: 'passed' });
    expect(s.runtime.ran.size).toBe(1);
    s.at(CHECK_EVERY_MS - 1);
    expect(dueForCheck(s.template(), new Date(T0 + CHECK_EVERY_MS - 1))).toBe(false);
    await s.pass();
    expect(s.runtime.ran.size).toBe(1);
  });

  it('after a day it runs again; the passed check holds while it runs, and a new pass replaces it', async () => {
    const s = setup();
    await s.pass();
    const first = s.template().check!;
    s.at(CHECK_EVERY_MS);
    expect(dueForCheck(s.template(), new Date(T0 + CHECK_EVERY_MS))).toBe(true);
    await s.pass();
    expect(s.runtime.ran.size).toBe(2);
    // The first run waited on the check; the scheduled one ran while the template stayed open.
    expect(s.seenWhileRunning).toEqual([expect.stringContaining('it runs now'), undefined]);
    expect(s.recorded.map((c) => c.state)).toEqual(['running', 'passed', 'passed']);
    expect(s.template().check).toMatchObject({ state: 'passed', version: first.version, at: new Date(T0 + CHECK_EVERY_MS).toISOString() });
  });

  it('a scheduled check that fails blocks the template', async () => {
    const s = setup();
    await s.pass();
    s.cloud.setMode('writable');
    s.at(CHECK_EVERY_MS);
    await s.pass();
    expect(s.template().check).toMatchObject({ state: 'failed' });
    expect(checkWait(s.template())).toContain('it failed (kube.create-namespace on lab (allowed)');
    // A failed check waits for a person: the schedule does not run it again.
    s.at(3 * CHECK_EVERY_MS);
    await s.pass();
    expect(s.runtime.ran.size).toBe(2);
  });
});
