// Issue #1202: the hopper removes its leftover box builds (src/sandbox/leftover-builds.ts) on a client target too, so the
// machine's client carries an image list and an image remove — the remote runtime's far end (src/client/runtime.ts,
// `POST /runtime`). Each is checked there: the list answers only the hopper's box builds, and only one of those is
// removed. The real client on a link, the runtime an API double on a unix socket (test/support/fake-runtime-api.ts).
//
// Feature: a client target removes the hopper's box builds, and nothing else
//   Scenario: the image list is carried with only the hopper's box builds in it; a list with other options is refused
//   Scenario: a box build of the hopper's is removed, never forced; anyone else's image, a name, or a forced remove is refused
import { afterEach, describe, expect, it } from 'vitest';
import { clientRuntimeCall } from '../../src/executors/client.ts';
import { startTestClient, type TestClient } from '../support/client.ts';
import { on, startFakeRuntimeApi, type FakeRuntimeApi } from '../support/fake-runtime-api.ts';

const TOKEN = 'a'.repeat(43);
const API = '/v5.0.0/libpod';
let c: TestClient | undefined;
const apis: FakeRuntimeApi[] = [];
afterEach(async () => {
  await c?.stop();
  c = undefined;
  for (const a of apis.splice(0)) await a.close();
});

async function client(sockets: { podman?: string; docker?: string }): Promise<TestClient> {
  c = await startTestClient({ token: () => TOKEN, herdrBin: '/bin/false', session: 'hopper', runtimeSockets: () => sockets });
  return c;
}
async function api(handlers: Parameters<typeof startFakeRuntimeApi>[0] = []): Promise<FakeRuntimeApi> {
  const a = await startFakeRuntimeApi(handlers);
  apis.push(a);
  return a;
}

describe('the hopper\'s box builds on the machine (issue #1202)', () => {
  const ID = (c: string): string => c.repeat(64);
  const IMAGES = [
    { Id: ID('a'), RepoTags: ['localhost/hopper-box-tools:0123456789abcdef'], Created: 1, Labels: { 'io.hopper.tools': 'kubectl' } },
    { Id: ID('b'), RepoTags: null, Created: 2, Labels: { 'io.hopper.tools-stage': 'fetch' } },
    { Id: ID('c'), RepoTags: ['docker.io/library/postgres:17'], Created: 3, Labels: {} },
    { Id: ID('d'), RepoTags: null, Created: 4, Labels: null },
    { Id: ID('e'), RepoTags: ['localhost/hopper-box-tools:0123456789abcdef', 'example.org/kept:1'], Created: 5, Labels: {} },
  ];

  it('the image list is carried with only the hopper\'s box builds in it; a list with other options is refused', async () => {
    for (const [kind, base, all] of [['podman', API, 'true'], ['docker', '/v1.41', '1']] as const) {
      const a = await api([on('GET', `${base}/images/json`, { status: 200, body: IMAGES })]);
      const t = (await client({ [kind]: a.socket })).transport(TOKEN);
      const listed = await clientRuntimeCall(t, { method: 'GET', path: `${base}/images/json?all=${all}` });
      expect(listed.status).toBe(200);
      expect((JSON.parse(listed.text) as { Id: string }[]).map((i) => i.Id)).toEqual([ID('a'), ID('b')]);
      const filtered = await clientRuntimeCall(t, { method: 'GET', path: `${base}/images/json?all=${all}&filters=x` });
      expect(filtered.status).toBe(403);
      expect(JSON.parse(filtered.text).message).toContain('the images are listed with');
      expect(a.seen.filter((r) => r.path === `${base}/images/json`)).toHaveLength(1);
      await c!.stop();
      c = undefined;
    }
  });

  it('a box build of the hopper\'s is removed, never forced; anyone else\'s image, a name, or a forced remove is refused', async () => {
    for (const [kind, base] of [['podman', API], ['docker', '/v1.41']] as const) {
      const inspect = (i: (typeof IMAGES)[number]) => kind === 'podman' ? { Id: i.Id, RepoTags: i.RepoTags, Labels: i.Labels } : { Id: `sha256:${i.Id}`, RepoTags: i.RepoTags ?? [], Config: { Labels: i.Labels } };
      const a = await api([
        on('GET', /\/images\/[^/]+\/json$/, (r) => {
          const id = decodeURIComponent(r.path.split('/').at(-2)!).replace(/^sha256:/, '');
          const i = IMAGES.find((x) => x.Id === id);
          return i ? { status: 200, body: inspect(i) } : { status: 404, body: { message: 'no such image' } };
        }),
        on('DELETE', /\/images\/[^/]+$/, { status: 200, body: [{ Deleted: 'x' }] }),
      ]);
      const t = (await client({ [kind]: a.socket })).transport(TOKEN);
      const removes = () => a.seen.filter((r) => r.method === 'DELETE');
      expect((await clientRuntimeCall(t, { method: 'DELETE', path: `${base}/images/${ID('a')}` })).status).toBe(200);
      expect((await clientRuntimeCall(t, { method: 'DELETE', path: `${base}/images/${encodeURIComponent(`sha256:${ID('b')}`)}` })).status).toBe(200);
      expect(removes().map((r) => [...r.query.keys()])).toEqual([[], []]);
      for (const [path, why] of [
        [`${base}/images/${ID('c')}`, 'is not a box build of the hopper\'s'],
        [`${base}/images/${ID('d')}`, 'is not a box build of the hopper\'s'],
        [`${base}/images/${ID('e')}`, 'is not a box build of the hopper\'s'],
        [`${base}/images/${encodeURIComponent('localhost/hopper-box-tools:0123456789abcdef')}`, 'removed by its id'],
        [`${base}/images/${ID('a')}?force=true`, 'never forced'],
      ] as const) {
        const r = await clientRuntimeCall(t, { method: 'DELETE', path });
        expect(r.status).toBe(403);
        expect(JSON.parse(r.text).message).toContain(why);
      }
      expect(removes()).toHaveLength(2);
      expect((await clientRuntimeCall(t, { method: 'DELETE', path: `${base}/images/${ID('f')}` })).status).toBe(404);
      await c!.stop();
      c = undefined;
    }
  });
});
