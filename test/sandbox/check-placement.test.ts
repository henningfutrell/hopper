// Issue #708: where the read-only check (issue #716) runs. Before, it ran only beside the hopper: a hopper given no
// runtime socket never checked a template, and a read-only template waited for its check for good. Now a check runs
// beside the hopper when it is given a runtime, else on a client target of the template's user that is dialled in and
// has a runtime there. The placement with client targets as doubles; the pass with the runtime as a double whose
// one-shot boxes run the check's real script with fake tools.
//
// Feature: the read-only check runs where a runtime is
//   Scenario: beside the hopper when it is given a runtime; else the first client target dialled in with one; else nowhere
//   Scenario: a hopper with no runtime checks the template on a client target, and removes the check boxes no run holds there first
//   Scenario: with nowhere to run, the template waits: no check is recorded, and it runs once a place is there
import { afterEach, describe, expect, it } from 'vitest';
import type { ReadOnlyCheck } from '../../src/domain/read-only-check.ts';
import type { RuntimeRelay } from '../../src/domain/sandboxes.ts';
import type { Template } from '../../src/domain/vault.ts';
import { CHECK_LABEL, createCheckPass, type CheckPlace } from '../../src/sandbox/check.ts';
import { HOPPER_PROBES } from '../../src/sandbox/probes.ts';
import { createPlacements, type ClientTargets } from '../../src/sandbox/runtime.ts';
import { createFakeCloudTools, type FakeCloudTools } from '../support/fake-cloud-tools.ts';
import { createFakeContainerRuntime } from '../support/fake-container-runtime.ts';

const fakes: FakeCloudTools[] = [];
afterEach(() => { for (const f of fakes.splice(0)) f.cleanup(); });

const IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';
const ROOTLESS = JSON.stringify({ host: { security: { rootless: true } } });
const relay = (which: Awaited<ReturnType<RuntimeRelay['which']>>): RuntimeRelay => ({ which: async () => which, call: async () => ({ status: 200, text: ROOTLESS }) });

/** The user `u` has two client targets dialled in: `away` with no runtime, then `studio` with Podman. */
const clients: ClientTargets = Object.assign(
  (_userId: string, machine: string) => {
    if (machine === 'away') return { relay: relay({ problem: 'no Podman or Docker socket on this machine' }) };
    if (machine === 'studio') return { relay: relay({ kind: 'podman' }) };
    return undefined;
  },
  { dialledIn: (userId: string) => (userId === 'u' ? ['away', 'studio'] : []), allDialledIn: () => [{ userId: 'u', machine: 'away' }, { userId: 'u', machine: 'studio' }], known: (userId: string) => userId === 'u' },
);

describe('where the read-only check runs (issue #708)', () => {
  it('beside the hopper when it is given a runtime; else the first client target dialled in with one; else nowhere', async () => {
    const local = createFakeContainerRuntime();
    const beside = createPlacements({ local, network: 'hopper_default', clients });
    expect(await beside.forCheck('u')).toEqual({ machine: 'local', runtime: local, network: 'hopper_default', secrets: true });

    const none = createPlacements({ local: undefined, network: 'hopper_default', clients });
    const at = await none.forCheck('u');
    expect(at).toMatchObject({ machine: 'studio', network: 'host' });
    expect(at!.runtime.kind).toBe('remote');
    expect(await none.forCheck('v')).toBeUndefined();
    expect(await createPlacements({ local: undefined, network: 'host' }).forCheck('u')).toBeUndefined();
  });

  it('a hopper with no runtime checks the template on a client target, and removes the check boxes no run holds there first', async () => {
    const s = setup();
    const left = s.studio.put({ name: 'hopper-check-old', image: IMAGE, network: 'host', volume: 'hopper-check-old-home', env: {}, labels: { [CHECK_LABEL]: 'i' }, limits: { cpus: 1, memoryMb: 512 }, user: 'agent' });
    s.place = { machine: 'studio', runtime: s.studio, network: 'host' };
    await s.pass();
    expect(s.template().check).toMatchObject({ state: 'passed' });
    expect([...s.studio.boxes.values()].map((b) => b.id)).not.toContain(left);
    expect(s.studio.volumes.has('hopper-check-old-home')).toBe(false);
    const [ran] = [...s.studio.ran.values()];
    expect(ran).toMatchObject({ network: 'host', labels: { [CHECK_LABEL]: 'i', 'io.hopper.user': 'u' } });
    expect(s.studio.boxes.size).toBe(0);
    expect(s.logged).toContain('hopper: the read-only check of template asked-0123456789ab passed on studio');
  });

  it('with nowhere to run, the template waits: no check is recorded, and it runs once a place is there', async () => {
    const s = setup();
    await s.pass();
    expect(s.recorded).toEqual([]);
    expect(s.template().check).toBeUndefined();
    s.place = { machine: 'studio', runtime: s.studio, network: 'host' };
    await s.pass();
    expect(s.recorded.map((c) => c.state)).toEqual(['running', 'passed']);
  });
});

function setup() {
  const cloud = createFakeCloudTools('read-only');
  fakes.push(cloud);
  const studio = createFakeContainerRuntime();
  studio.runScript = (spec) => cloud.runScript(spec);
  let template: Template = {
    name: 'asked-0123456789ab', image: IMAGE, secrets: [], profiles: [{ operation: 'read', asset: { kind: 'cluster', name: 'lab' } }],
    readOnly: true, savedBy: 'job j', savedAt: '2030-01-01T00:00:00.000Z',
    approval: { image: IMAGE, secrets: [], by: 'the read policy', at: '2030-01-01T00:00:01.000Z' },
  };
  const recorded: ReadOnlyCheck[] = [];
  const logged: string[] = [];
  const at: { place: CheckPlace | undefined } = { place: undefined };
  const s = {
    studio, recorded, logged, template: () => template,
    get place() { return at.place; },
    set place(p: CheckPlace | undefined) { at.place = p; },
    pass: createCheckPass({
      place: async () => at.place, instanceId: 'i', probes: HOPPER_PROBES, clock: { now: () => new Date('2030-01-01T00:01:00Z') },
      logger: { info: (l) => { logged.push(l); }, warn: () => {} },
      credentials: { credential: async () => ({ minted: { kind: 'kube', token: 't', expirationTimestamp: '2030-01-01T00:10:00Z' }, reach: { kind: 'kube', server: 'https://k' } }) },
    }, {
      templates: () => [{ userId: 'u', template }],
      record: async (_u, _n, check) => { recorded.push(check); template = { ...template, check }; },
      credential: async () => ({ refused: 'unused' }),
      report: async () => undefined,
    }),
  };
  return s;
}
