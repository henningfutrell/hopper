// Issue #1349: a sandbox does one step and is burned, on a client target as beside the hopper. Before, the sweep and the
// burn pass looked only beside the hopper and at the client targets a sandbox record named: a need box left on a client
// target, or a box an older build launched there with no record, stayed for good, and its run stayed open. Now both look
// on every client target dialled in, and on the one an open run names; a target that is away keeps its boxes and its
// runs open until it dials in. The client target's Podman is a libpod double (test/support/fake-libpod.ts) reached
// through a relay, as its client carries the calls; the hopper has no runtime of its own here.
//
// Feature: sandboxes on a client target are burned
//   Scenario: a need box on a client target that outlived its step is burned with its home, and its run ends as swept
//   Scenario: another user's box on the same runtime stays
//   Scenario: while the client target is away its run stays open; once it dials in again the sweep burns its box
//   Scenario: a box an older build launched on a client target with no sandbox record is burned
//   Scenario: a run on a client target that was removed is closed: no runtime is there to say its box went
import { describe, expect, it } from 'vitest';
import type { RuntimeRelay, SandboxRecord } from '../../src/domain/sandboxes.ts';
import type { SandboxRepository } from '../../src/domain/store.ts';
import { NEED_LABEL } from '../../src/sandbox/need-box.ts';
import type { ClientTargets } from '../../src/sandbox/runtime.ts';
import { BOX_LABEL, createSandboxes, USER_LABEL } from '../../src/sandbox/service.ts';
import { createFakeLibpod, type FakeLibpod } from '../support/fake-libpod.ts';
import { memorySandboxRuns } from '../support/sandbox-runs.ts';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const INSTANCE = 'test';

function memoryRepo(): SandboxRepository {
  const rows = new Map<string, SandboxRecord>();
  return {
    list: () => [...rows.values()],
    add: (r) => (rows.has(r.id) ? false : (rows.set(r.id, r), true)),
    remove: (id) => rows.delete(id),
  };
}

/** The calls a client carries, answered by the libpod double's handlers. */
const relayTo = (libpod: FakeLibpod): RuntimeRelay => ({
  which: async () => ({ kind: 'podman' }),
  call: async (c) => {
    const url = new URL(c.path, 'http://localhost');
    const r = { method: c.method, path: url.pathname, query: url.searchParams, body: c.body };
    const a = libpod.handlers.map((h) => h(r)).find((x) => x !== undefined) ?? { status: 404, body: { message: 'no such thing' } };
    return { status: a.status, text: a.text ?? (a.body === undefined ? '' : JSON.stringify(a.body)) };
  },
});

function setup() {
  const libpod = createFakeLibpod();
  const runs = memorySandboxRuns();
  const repo = memoryRepo();
  const studio = { dialledIn: true, removed: false };
  // The user u1 has one client target, studio; u2 has none.
  const clients: ClientTargets = Object.assign(
    (userId: string, machine: string) => (userId === 'u1' && machine === 'studio' && studio.dialledIn ? { relay: relayTo(libpod) } : undefined),
    {
      dialledIn: (userId: string) => (userId === 'u1' && studio.dialledIn ? ['studio'] : []),
      allDialledIn: () => (studio.dialledIn ? [{ userId: 'u1', machine: 'studio' }] : []),
      known: (userId: string, machine: string) => userId === 'u1' && machine === 'studio' && !studio.removed,
    },
  );
  const sandboxes = createSandboxes({ runtime: undefined, repo, runs, instanceId: INSTANCE, network: 'host', clients, clock: { now: () => NOW }, logger: { info() {}, warn() {} } });
  return { libpod, runs, repo, studio, sandboxes };
}

/** A need box on the client target that no step holds, with its home volume. */
function needBox(libpod: FakeLibpod, name: string, userId = 'u1'): void {
  const labels = { [NEED_LABEL]: INSTANCE, [USER_LABEL]: userId };
  const query = new URLSearchParams();
  libpod.handlers[0]!({ method: 'POST', path: '/v5.0.0/libpod/volumes/create', query, body: { Name: `${name}-home`, Label: labels } });
  libpod.put({ name, image: 'ghcr.io/henningfutrell/hopper:box-claude', labels });
}
const on = (libpod: FakeLibpod, name: string) => [...libpod.containers.values()].find((c) => c.name === name);

describe('sandboxes on a client target are burned (issue #1349)', () => {
  it('a need box on a client target that outlived its step is burned with its home, and its run ends as swept', async () => {
    const { libpod, runs, sandboxes } = setup();
    runs.start({ id: 's-1', userId: 'u1', jobId: 'job-1', template: 'asked-1', box: 'hopper-need-asked-1-aaaa', machine: 'studio', startedAt: '2026-10-15T11:00:00.000Z' });
    needBox(libpod, 'hopper-need-asked-1-aaaa');
    // A need box of no run: a step whose run was never written. It is burned too.
    needBox(libpod, 'hopper-need-asked-1-bbbb');
    await sandboxes.check();
    expect(on(libpod, 'hopper-need-asked-1-aaaa')).toBeUndefined();
    expect(on(libpod, 'hopper-need-asked-1-bbbb')).toBeUndefined();
    expect([...libpod.volumes]).toEqual([]);
    expect(runs.get('s-1')).toMatchObject({ outcome: 'swept', endedAt: NOW.toISOString(), destroyedAt: NOW.toISOString(), problem: expect.stringContaining('burned by the sweep') });
    expect(runs.open()).toEqual([]);
  });

  it('another user\'s box on the same runtime stays', async () => {
    const { libpod, sandboxes } = setup();
    needBox(libpod, 'hopper-need-other-cccc', 'u2');
    await sandboxes.check();
    expect(on(libpod, 'hopper-need-other-cccc')).toBeDefined();
    expect(libpod.volumes.has('hopper-need-other-cccc-home')).toBe(true);
  });

  it('while the client target is away its run stays open; once it dials in again the sweep burns its box', async () => {
    const { libpod, runs, studio, sandboxes } = setup();
    runs.start({ id: 's-2', userId: 'u1', jobId: 'job-1', template: 'asked-1', box: 'hopper-need-asked-1-dddd', machine: 'studio', startedAt: '2026-10-15T11:00:00.000Z' });
    needBox(libpod, 'hopper-need-asked-1-dddd');
    studio.dialledIn = false;
    await sandboxes.check();
    expect(on(libpod, 'hopper-need-asked-1-dddd')).toBeDefined();
    expect(runs.get('s-2')!.destroyedAt).toBeUndefined();

    studio.dialledIn = true;
    await sandboxes.check();
    expect(on(libpod, 'hopper-need-asked-1-dddd')).toBeUndefined();
    expect(runs.get('s-2')).toMatchObject({ outcome: 'swept', destroyedAt: NOW.toISOString() });
  });

  it('a box an older build launched on a client target with no sandbox record is burned', async () => {
    const { libpod, repo, sandboxes } = setup();
    libpod.put({ name: 'hopper-sandbox-claude-2', image: 'ghcr.io/henningfutrell/hopper:box-claude', labels: { [BOX_LABEL]: INSTANCE, [USER_LABEL]: 'u1' } });
    // Another hopper's box on the same machine stays.
    libpod.put({ name: 'hopper-sandbox-other', image: 'ghcr.io/henningfutrell/hopper:box-claude', labels: { [BOX_LABEL]: 'another-hopper', [USER_LABEL]: 'u1' } });
    expect(repo.list()).toEqual([]);
    await sandboxes.burnLaunched();
    expect(on(libpod, 'hopper-sandbox-claude-2')).toBeUndefined();
    expect(on(libpod, 'hopper-sandbox-other')).toBeDefined();
  });

  it('a run on a client target that was removed is closed: no runtime is there to say its box went', async () => {
    const { runs, studio, sandboxes } = setup();
    runs.start({ id: 's-3', userId: 'u1', jobId: 'job-1', template: 'asked-1', box: 'hopper-need-asked-1-eeee', machine: 'studio', startedAt: '2026-10-15T11:00:00.000Z' });
    // A run of a machine the user never had, or one of a user who is gone, is closed the same way.
    runs.start({ id: 's-4', userId: 'u2', jobId: 'job-2', template: 'asked-2', box: 'hopper-need-asked-2-ffff', machine: 'attic', startedAt: '2026-10-15T11:00:00.000Z' });
    studio.dialledIn = false;
    studio.removed = true;
    await sandboxes.check();
    for (const id of ['s-3', 's-4']) {
      expect(runs.get(id)).toMatchObject({ outcome: 'swept', endedAt: NOW.toISOString(), destroyedAt: NOW.toISOString(), machineRemoved: true, problem: expect.stringContaining('its machine was removed') });
    }
    expect(runs.open()).toEqual([]);
  });
});
