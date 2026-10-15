// Issue #1120, part 4: the Podman and Docker runtimes list the images on the machine and remove one, so the hopper can
// remove its leftover box builds (src/sandbox/leftover-builds.ts). Against the API doubles of
// test/support/fake-runtime-api.ts.
//
// Feature: a runtime lists and removes images
//   Scenario: Podman lists every image, intermediate ones too, with its tags, its time and its labels
//   Scenario: Docker lists every image the same way; its "<none>" tag is no tag
//   Scenario: a remove is never forced; gone or kept (in use, or a parent) is false, removed is true
//   Scenario: any other refusal of a remove fails with the runtime's own words
import { afterEach, describe, expect, it } from 'vitest';
import { createDockerRuntime } from '../../src/sandbox/docker.ts';
import { createPodmanRuntime } from '../../src/sandbox/podman.ts';
import { on, startFakeRuntimeApi, type FakeRuntimeApi } from '../support/fake-runtime-api.ts';

const PODMAN = '/v5.0.0/libpod';
const DOCKER = '/v1.41';
let api: FakeRuntimeApi | undefined;
afterEach(async () => { await api?.close(); api = undefined; });

describe('a runtime lists and removes images (issue #1120)', () => {
  it('Podman lists every image, intermediate ones too, with its tags, its time and its labels', async () => {
    api = await startFakeRuntimeApi([on('GET', `${PODMAN}/images/json`, {
      status: 200,
      body: [
        { Id: 'aaa1', RepoTags: ['localhost/hopper-box-tools:0123456789abcdef'], Created: 1_760_000_000, Labels: { 'io.hopper.tools': 'kubectl' } },
        { Id: 'bbb2', RepoTags: null, Created: 1_760_000_100, Labels: null },
      ],
    })]);
    const images = await createPodmanRuntime(api.socket).listImages!();
    expect(api.seen[0]!.query.get('all')).toBe('true');
    expect(images).toEqual([
      { id: 'aaa1', tags: ['localhost/hopper-box-tools:0123456789abcdef'], createdAt: 1_760_000_000_000, labels: { 'io.hopper.tools': 'kubectl' } },
      { id: 'bbb2', tags: [], createdAt: 1_760_000_100_000, labels: {} },
    ]);
  });

  it('Docker lists every image the same way; its "<none>" tag is no tag', async () => {
    api = await startFakeRuntimeApi([on('GET', `${DOCKER}/images/json`, {
      status: 200,
      body: [{ Id: 'sha256:ccc3', RepoTags: ['<none>:<none>'], Created: 1_760_000_200, Labels: { 'io.hopper.tools-stage': 'fetch' } }],
    })]);
    const images = await createDockerRuntime(api.socket).listImages!();
    expect(api.seen[0]!.query.get('all')).toBe('1');
    expect(images).toEqual([{ id: 'sha256:ccc3', tags: [], createdAt: 1_760_000_200_000, labels: { 'io.hopper.tools-stage': 'fetch' } }]);
  });

  it('a remove is never forced; gone or kept (in use, or a parent) is false, removed is true', async () => {
    for (const [make, base] of [[createPodmanRuntime, PODMAN], [createDockerRuntime, DOCKER]] as const) {
      api = await startFakeRuntimeApi([
        on('DELETE', `${base}/images/gone`, { status: 404, body: { message: 'no such image' } }),
        on('DELETE', `${base}/images/kept`, { status: 409, body: { message: 'image is in use by a container' } }),
        on('DELETE', `${base}/images/sha256%3Aold`, { status: 200, body: [{ Deleted: 'sha256:old' }] }),
        on('DELETE', `${base}/images/sha256:old`, { status: 200, body: [{ Deleted: 'sha256:old' }] }),
      ]);
      const rt = make(api.socket);
      expect(await rt.removeImage!('gone')).toBe(false);
      expect(await rt.removeImage!('kept')).toBe(false);
      expect(await rt.removeImage!('sha256:old')).toBe(true);
      for (const r of api.seen) expect([...r.query.keys()]).toEqual([]);
      await api.close();
      api = undefined;
    }
  });

  it('any other refusal of a remove fails with the runtime\'s own words', async () => {
    api = await startFakeRuntimeApi([on('DELETE', `${PODMAN}/images/x`, { status: 500, body: { message: 'storage is locked' } })]);
    await expect(createPodmanRuntime(api.socket).removeImage!('x')).rejects.toThrow('storage is locked');
  });
});
