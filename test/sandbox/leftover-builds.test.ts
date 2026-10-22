// Issue #1120, part 4: the images the hopper built for box tools stayed on the machine after their boxes went, and so
// did the stages of each build. The sandbox module removes them: src/sandbox/leftover-builds.ts, from its reconcile pass.
//
// Feature: leftover box builds
//   Scenario: a build of box tools that no container uses and that is older than the keep time is leftover
//     Given images beside the hopper: a box-tools image, a stage of a build, an image of the person's own, and an untagged
//       image of the person's own
//     Then only the box-tools image and the stage are leftover, newest first
//   Scenario: a build a container or a sandbox record uses, one built in the keep time, or one with another name too stays
//   Scenario: the removal removes each leftover build, never forced, and says how many it removed
//   Scenario: a runtime that lists no images removes nothing
//   Scenario: the reconcile pass removes leftover builds at most once an hour
//   Scenario: the reconcile pass removes leftover builds on a client target too, through its client (issue #1202)
//   Scenario: the reconcile pass removes leftover builds on each Podman host the sandbox host or an open run names (issue #2272)
import { describe, expect, it } from 'vitest';
import type { ListedImage, RuntimeRelay, SandboxRecord } from '../../src/domain/sandboxes.ts';
import type { SandboxRepository } from '../../src/domain/store.ts';
import { LEFTOVER_BUILD_MS, LEFTOVER_PASS_MS, leftoverBuilds, removeLeftoverBuilds } from '../../src/sandbox/leftover-builds.ts';
import { createSandboxes } from '../../src/sandbox/service.ts';
import { TOOLS_IMAGE, TOOLS_STAGE_LABEL } from '../../src/sandbox/tools.ts';
import type { ClientTargets } from '../../src/sandbox/runtime.ts';
import { createFakeContainerRuntime, type FakeContainerRuntime } from '../support/fake-container-runtime.ts';
import { memorySandboxRuns } from '../support/sandbox-runs.ts';

const NOW = new Date('2026-10-14T12:00:00.000Z');
const OLD = NOW.getTime() - LEFTOVER_BUILD_MS - 60_000;
const NEW = NOW.getTime() - 60_000;
const spec = { network: 'host', volume: 'v', env: {}, labels: {}, user: 'agent', limits: { cpus: 1, memoryMb: 512 } };

const tools = (hash: string, createdAt = OLD): ListedImage => ({ id: `sha256:t${hash}`, tags: [`${TOOLS_IMAGE}:${hash}`], createdAt, labels: { 'io.hopper.tools': 'kubectl' } });
const stage = (id: string, createdAt = OLD): ListedImage => ({ id, tags: [], createdAt, labels: { [TOOLS_STAGE_LABEL]: 'fetch' } });
const own: ListedImage = { id: 'sha256:own', tags: ['docker.io/library/postgres:17'], createdAt: OLD, labels: {} };
const ownUntagged: ListedImage = { id: 'sha256:mine', tags: [], createdAt: OLD, labels: {} };

/** The fake runtime with images: removeImage takes one that no container uses. */
function withImages(rt: FakeContainerRuntime, images: ListedImage[]): { removed: string[] } {
  const seen = { removed: [] as string[] };
  let listed = [...images];
  rt.listImages = async () => listed;
  rt.removeImage = async (id) => {
    const i = listed.find((x) => x.id === id);
    if (!i || [...rt.boxes.values()].some((c) => i.tags.includes(c.spec.image))) return false;
    listed = listed.filter((x) => x !== i);
    seen.removed.push(id);
    return true;
  };
  return seen;
}

function memoryRepo(rows: SandboxRecord[] = []): SandboxRepository {
  const m = new Map(rows.map((r) => [r.id, r]));
  return { list: () => [...m.values()], add: (r) => (m.has(r.id) ? false : (m.set(r.id, r), true)), remove: (id) => m.delete(id) };
}

describe('leftover box builds (issue #1120)', () => {
  it('a build of box tools that no container uses and that is older than the keep time is leftover', () => {
    const left = leftoverBuilds([own, tools('aaaa'), ownUntagged, stage('sha256:s1', OLD + 1000)], { inUse: new Set(), now: NOW });
    expect(left.map((i) => i.id)).toEqual(['sha256:s1', 'sha256:taaaa']);
  });

  it('a build a container or a sandbox record uses, one built in the keep time, or one with another name too stays', () => {
    const named = { ...tools('cccc'), tags: [`${TOOLS_IMAGE}:cccc`, 'example.org/kept:1'] };
    const left = leftoverBuilds([tools('aaaa'), tools('bbbb', NEW), named, stage('sha256:s2', NEW), tools('dddd')], { inUse: new Set([`${TOOLS_IMAGE}:aaaa`, 'tdddd']), now: NOW });
    expect(left).toEqual([]);
  });

  it('the removal removes each leftover build, never forced, and says how many it removed', async () => {
    const rt = createFakeContainerRuntime();
    rt.put({ ...spec, name: 'hopper-sandbox-kube', image: `${TOOLS_IMAGE}:bbbb` });
    const seen = withImages(rt, [tools('aaaa'), tools('bbbb'), tools('cccc'), stage('sha256:s1'), own]);
    const lines: string[] = [];
    const removed = await removeLeftoverBuilds({ runtime: rt, now: NOW, inUse: [`${TOOLS_IMAGE}:cccc`], logger: { info: (l: string) => lines.push(l) } });
    expect(removed).toBe(2);
    expect(seen.removed.sort()).toEqual(['sha256:s1', 'sha256:taaaa']);
    expect(lines).toEqual(['hopper: removed 2 leftover box builds beside the hopper (images it built for box tools more than 7 days ago that no box uses)']);
  });

  it('a runtime that lists no images removes nothing', async () => {
    const rt = createFakeContainerRuntime();
    expect(await removeLeftoverBuilds({ runtime: rt, now: NOW, inUse: [], logger: { info() {} } })).toBe(0);
  });

  it('the reconcile pass removes leftover builds at most once an hour', async () => {
    const rt = createFakeContainerRuntime();
    const seen = withImages(rt, [tools('aaaa')]);
    let now = NOW;
    const sandboxes = createSandboxes({
      runtime: rt, repo: memoryRepo(), runs: memorySandboxRuns(), instanceId: 'test', network: 'host',
      clock: { now: () => now }, logger: { info() {}, warn() {} },
    });
    await sandboxes.burnLaunched();
    expect(seen.removed).toEqual(['sha256:taaaa']);
    const again = withImages(rt, [tools('bbbb')]);
    now = new Date(NOW.getTime() + LEFTOVER_PASS_MS - 1000);
    await sandboxes.burnLaunched();
    expect(again.removed).toEqual([]);
    now = new Date(NOW.getTime() + LEFTOVER_PASS_MS);
    await sandboxes.burnLaunched();
    expect(again.removed).toEqual(['sha256:tbbbb']);
  });

  it('the reconcile pass removes leftover builds on a client target too, through its client (issue #1202)', async () => {
    const id = (c: string): string => c.repeat(64);
    let listed = [
      { Id: id('a'), RepoTags: [`${TOOLS_IMAGE}:0123456789abcdef`], Created: OLD / 1000, Labels: {} },
      { Id: id('b'), RepoTags: [`${TOOLS_IMAGE}:fedcba9876543210`], Created: OLD / 1000, Labels: {} },
      { Id: id('c'), RepoTags: null, Created: NEW / 1000, Labels: { [TOOLS_STAGE_LABEL]: 'fetch' } },
    ];
    const removed: string[] = [];
    const answer = (status: number, body: unknown) => ({ status, text: JSON.stringify(body) });
    const relay: RuntimeRelay = {
      which: async () => ({ kind: 'podman' }),
      call: async (c) => {
        const url = new URL(c.path, 'http://localhost');
        const path = url.pathname.replace('/v5.0.0/libpod', '');
        // A container of the person's own there uses one build: every container, not the hopper's labelled boxes.
        if (c.method === 'GET' && path === '/containers/json') return answer(200, url.searchParams.has('filters') ? [] : [{ Id: 'c1', Names: ['theirs'], Image: `${TOOLS_IMAGE}:fedcba9876543210`, Labels: {}, State: 'exited' }]);
        if (c.method === 'GET' && path === '/images/json') return answer(200, listed);
        const m = /^\/images\/([^/]+)$/.exec(path);
        if (c.method === 'DELETE' && m) {
          removed.push(decodeURIComponent(m[1]!));
          listed = listed.filter((i) => i.Id !== decodeURIComponent(m[1]!));
          return answer(200, [{ Deleted: m[1] }]);
        }
        return answer(404, { message: 'no such thing' });
      },
    };
    const clients: ClientTargets = Object.assign(
      (userId: string, machine: string) => (userId === 'u1' && machine === 'studio' ? { relay } : undefined),
      { dialledIn: () => ['studio'], allDialledIn: () => [{ userId: 'u1', machine: 'studio' }], known: () => true },
    );
    const lines: string[] = [];
    const sandboxes = createSandboxes({
      runtime: undefined, repo: memoryRepo(), runs: memorySandboxRuns(), instanceId: 'test', network: 'host', clients,
      clock: { now: () => NOW }, logger: { info: (l: string) => lines.push(l), warn() {} },
    });
    await sandboxes.burnLaunched();
    expect(removed).toEqual([id('a')]);
    expect(lines).toContain('hopper: removed 1 leftover box build on studio (images it built for box tools more than 7 days ago that no box uses)');
  });

  it('the reconcile pass removes leftover builds on each Podman host the sandbox host or an open run names (issue #2272)', async () => {
    const named = createFakeContainerRuntime(), ran = createFakeContainerRuntime(), idle = createFakeContainerRuntime();
    const seen = { named: withImages(named, [tools('aaaa'), own]), ran: withImages(ran, [stage('sha256:s1')]), idle: withImages(idle, [tools('bbbb')]) };
    const hosts = new Map([['box-vm', named], ['old-vm', ran], ['idle-vm', idle]]);
    const runs = memorySandboxRuns();
    runs.start({ id: 'r1', userId: 'u1', machine: 'old-vm', box: 'hopper-need-x', jobId: 'j1', step: 's1', template: 't', startedAt: NOW.toISOString() });
    const lines: string[] = [];
    const sandboxes = createSandboxes({
      runtime: undefined, repo: memoryRepo(), runs, instanceId: 'test', network: 'host', users: () => ['u1'],
      sandboxHost: () => ['box-vm'], podmanHosts: (userId, name) => (userId === 'u1' ? hosts.get(name) : undefined),
      clock: { now: () => NOW }, logger: { info: (l: string) => lines.push(l), warn() {} },
    });
    await sandboxes.burnLaunched();
    expect(seen.named.removed).toEqual(['sha256:taaaa']);
    expect(seen.ran.removed).toEqual(['sha256:s1']);
    expect(seen.idle.removed).toEqual([]);
    expect(lines).toContain('hopper: removed 1 leftover box build on box-vm (images it built for box tools more than 7 days ago that no box uses)');
  });
});
