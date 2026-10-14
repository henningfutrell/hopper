// Issue #708: a machine's client carries the hopper's container runtime calls to the machine's own Podman (or Docker)
// — the remote runtime's far end (src/client/runtime.ts, `POST /runtime`). The real client on a link, the runtime an
// API double on a unix socket (test/support/fake-runtime-api.ts, fake-libpod.ts).
//
// Feature: a client target runs the hopper's runtime calls against its own runtime
//   Scenario: the client says which runtime it has: Podman first, Docker else, none with what to do
//   Scenario: a runtime call is carried to the socket and its answer carried back
//   Scenario: a create without the sandbox flags, or with a mount of the machine, is refused
//   Scenario: a call on a container the hopper did not make is refused; a gone one answers 404
//   Scenario: a call outside the runtime calls the hopper makes is refused
//   Scenario: a box's one-shot stats are carried; another container's, or a stream, are refused (issue #947)
//   Scenario: a box's start check is carried: the create with its health check, and the check run on the hopper's box only
//   Scenario: a tools image's build is carried as a tar of its one Containerfile
//   Scenario: a build of anything but a tools image, with other build options, or of another context, is refused
//   Scenario: a check box is carried: its script, its end awaited, and its output as the bytes the runtime sent
//   Scenario: a script on a sandbox box, a check box without its one script, and a wait or a read of a sandbox box are refused
import { afterEach, describe, expect, it } from 'vitest';
import { clientRuntimeCall, clientRuntimeWhich } from '../../src/executors/client.ts';
import { libpodCreateBody, dockerCreateBody } from '../../src/sandbox/flags.ts';
import { containerfileTar } from '../../src/sandbox/socket-http.ts';
import { startTestClient, type TestClient } from '../support/client.ts';
import { createFakeLibpod } from '../support/fake-libpod.ts';
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

const spec = {
  name: 'hopper-sandbox-kube', image: 'example.org/kube-box:1', network: 'host', volume: 'hopper-sandbox-kube-home',
  env: { HOPPER_CLIENT_NAME: 'hopper-sandbox-kube' }, labels: { 'io.hopper.box': 'i-1', 'io.hopper.user': 'admin' },
  limits: { cpus: 1, memoryMb: 1024 }, user: 'agent',
};

describe('the remote runtime, on the machine', () => {
  it('the client says which runtime it has: Podman first, Docker else, none with what to do', async () => {
    const podman = await api();
    const docker = await api();
    let t = (await client({ podman: podman.socket, docker: docker.socket })).transport(TOKEN);
    expect(await clientRuntimeWhich(t)).toEqual({ kind: 'podman' });
    await c!.stop();
    t = (await client({ podman: '/nonexistent/podman.sock', docker: docker.socket })).transport(TOKEN);
    expect(await clientRuntimeWhich(t)).toEqual({ kind: 'docker' });
    await c!.stop();
    t = (await client({ podman: '/nonexistent/podman.sock' })).transport(TOKEN);
    const none = await clientRuntimeWhich(t);
    expect(none).toEqual({ problem: expect.stringContaining('no Podman or Docker socket') });
    expect((none as { problem: string }).problem).toContain('systemctl --user enable --now podman.socket');
  });

  it('a runtime call is carried to the socket and its answer carried back', async () => {
    const libpod = createFakeLibpod();
    const a = await api(libpod.handlers);
    const t = (await client({ podman: a.socket })).transport(TOKEN);
    expect(await clientRuntimeCall(t, { method: 'GET', path: `${API}/info` })).toEqual({ status: 200, text: JSON.stringify({ host: { security: { rootless: true } } }) });
    const made = await clientRuntimeCall(t, { method: 'POST', path: `${API}/containers/create`, body: libpodCreateBody(spec) });
    expect(made.status).toBe(201);
    expect(a.seen.at(-1)!.body).toEqual(libpodCreateBody(spec));
    const id = (JSON.parse(made.text) as { Id: string }).Id;
    expect((await clientRuntimeCall(t, { method: 'POST', path: `${API}/containers/${id}/start` })).status).toBe(204);
    expect(libpod.containers.get(id)!.state).toBe('running');
    const listed = await clientRuntimeCall(t, { method: 'GET', path: `${API}/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ label: ['io.hopper.box=i-1'] }))}` });
    expect(JSON.parse(listed.text)).toEqual([expect.objectContaining({ Id: id, Names: ['hopper-sandbox-kube'] })]);
    expect((await clientRuntimeCall(t, { method: 'DELETE', path: `${API}/containers/${id}?force=true&timeout=10` })).status).toBe(204);
    expect(libpod.containers.size).toBe(0);
  });

  it('a create without the sandbox flags, or with a mount of the machine, is refused', async () => {
    const a = await api(createFakeLibpod().handlers);
    const t = (await client({ podman: a.socket })).transport(TOKEN);
    const good = libpodCreateBody(spec);
    for (const [body, why] of [
      [{ ...good, cap_drop: [] }, 'every capability dropped'],
      [{ ...good, no_new_privileges: false }, 'no new privileges'],
      [{ ...good, read_only_filesystem: false }, 'a read-only root'],
      [{ ...good, privileged: true }, 'privileged'],
      [{ ...good, mounts: [{ destination: '/host', type: 'bind', source: '/', options: [] }] }, 'only a tmpfs at /tmp'],
      [{ ...good, volumes: [{ Name: 'someone-elses', Dest: '/home/agent' }] }, 'only its own home volume'],
      [{ ...good, user: 'root' }, 'a non-root user'],
      [{ ...good, name: 'web' }, 'hopper-sandbox-'],
      [{ ...good, labels: {} }, 'io.hopper.box'],
    ] as const) {
      const r = await clientRuntimeCall(t, { method: 'POST', path: `${API}/containers/create`, body });
      expect(r.status).toBe(403);
      expect(JSON.parse(r.text).message).toContain(why);
    }
    expect(a.seen.filter((s) => s.path.endsWith('/containers/create'))).toEqual([]);
  });

  it('a Docker create is checked the same way', async () => {
    const a = await api([on('POST', '/v1.41/containers/create', { status: 201, body: { Id: 'd1' } })]);
    const t = (await client({ docker: a.socket })).transport(TOKEN);
    const good = dockerCreateBody(spec);
    expect((await clientRuntimeCall(t, { method: 'POST', path: `/v1.41/containers/create?name=${spec.name}`, body: good })).status).toBe(201);
    const bound = { ...good, HostConfig: { ...(good.HostConfig as object), Binds: ['/:/host'] } };
    const r = await clientRuntimeCall(t, { method: 'POST', path: `/v1.41/containers/create?name=${spec.name}`, body: bound });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.text).message).toContain('Binds');
  });

  it('a call on a container the hopper did not make is refused; a gone one answers 404', async () => {
    const libpod = createFakeLibpod();
    const theirs = libpod.put({ name: 'postgres', image: 'postgres', labels: {} });
    const a = await api(libpod.handlers);
    const t = (await client({ podman: a.socket })).transport(TOKEN);
    for (const [method, path] of [['POST', `/containers/${theirs}/stop`], ['DELETE', `/containers/${theirs}?force=true`], ['GET', `/containers/${theirs}/json`], ['POST', `/containers/${theirs}/start`]] as const) {
      const r = await clientRuntimeCall(t, { method, path: API + path });
      expect(r.status).toBe(403);
      expect(JSON.parse(r.text).message).toContain('not a sandbox box the hopper made');
    }
    expect(libpod.containers.get(theirs)!.state).toBe('running');
    expect((await clientRuntimeCall(t, { method: 'DELETE', path: `${API}/containers/gone?force=true` })).status).toBe(404);
    expect((await clientRuntimeCall(t, { method: 'DELETE', path: `${API}/volumes/pgdata?force=true` })).status).toBe(403);
  });

  it('a call outside the runtime calls the hopper makes is refused', async () => {
    const a = await api(createFakeLibpod().handlers);
    const t = (await client({ podman: a.socket })).transport(TOKEN);
    for (const [method, path] of [['POST', `${API}/containers/c1/exec`], ['GET', `${API}/secrets/json`], ['POST', `${API}/../v1.41/containers/create`], ['GET', '/v1.41/info']] as const) {
      const r = await clientRuntimeCall(t, { method, path });
      expect(r.status).toBe(403);
    }
    expect(a.seen).toEqual([]);
  });

  it('a box\'s one-shot stats are carried; another container\'s, or a stream, are refused (issue #947)', async () => {
    const libpod = createFakeLibpod();
    const box = libpod.put({ name: 'hopper-sandbox-kube', image: 'box', labels: { 'io.hopper.box': 'i-1' } });
    const theirs = libpod.put({ name: 'postgres', image: 'postgres', labels: {} });
    const a = await api([on('GET', /\/stats$/, { status: 200, body: { cpu_stats: { online_cpus: 4 } } }), ...libpod.handlers]);
    const t = (await client({ podman: a.socket })).transport(TOKEN);
    expect(await clientRuntimeCall(t, { method: 'GET', path: `${API}/containers/${box}/stats?stream=false` })).toEqual({ status: 200, text: JSON.stringify({ cpu_stats: { online_cpus: 4 } }) });
    for (const [path, why] of [
      [`${API}/containers/${theirs}/stats?stream=false`, 'not a sandbox box the hopper made'],
      [`${API}/containers/${box}/stats`, 'stream=false'],
      [`${API}/containers/${box}/stats?stream=true`, 'stream=false'],
      [`${API}/containers/${box}/stats?stream=false&one-shot=true`, 'stream=false'],
    ] as const) {
      const r = await clientRuntimeCall(t, { method: 'GET', path });
      expect(r.status).toBe(403);
      expect(JSON.parse(r.text).message).toContain(why);
    }
    expect((await clientRuntimeCall(t, { method: 'POST', path: `${API}/containers/${box}/stats?stream=false` })).status).toBe(403);
    expect(a.seen.filter((s) => s.path.endsWith('/stats'))).toHaveLength(1);
  });

  it('a box\'s start check is carried: the create with its health check, and the check run on the hopper\'s box only', async () => {
    const libpod = createFakeLibpod();
    const theirs = libpod.put({ name: 'postgres', image: 'postgres', labels: {} });
    const a = await api(libpod.handlers);
    const t = (await client({ podman: a.socket })).transport(TOKEN);
    const made = await clientRuntimeCall(t, { method: 'POST', path: `${API}/containers/create`, body: libpodCreateBody({ ...spec, check: 'http://hopper:4790' }) });
    expect(made.status).toBe(201);
    const id = (JSON.parse(made.text) as { Id: string }).Id;
    await clientRuntimeCall(t, { method: 'POST', path: `${API}/containers/${id}/start` });
    const ran = await clientRuntimeCall(t, { method: 'GET', path: `${API}/containers/${id}/healthcheck` });
    expect(ran.status).toBe(200);
    expect(JSON.parse(ran.text)).toMatchObject({ Status: 'healthy' });
    expect((await clientRuntimeCall(t, { method: 'GET', path: `${API}/containers/${theirs}/healthcheck` })).status).toBe(403);
    const odd = { ...libpodCreateBody({ ...spec, check: 'http://hopper:4790' }), healthconfig: { Test: ['CMD', 'true'], StartupHealthConfig: {} } };
    const r = await clientRuntimeCall(t, { method: 'POST', path: `${API}/containers/create`, body: odd });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.text).message).toContain('StartupHealthConfig');
  });

  it('a tools image\'s build is carried as a tar of its one Containerfile', async () => {
    const libpod = createFakeLibpod();
    const a = await api(libpod.handlers);
    const t = (await client({ podman: a.socket })).transport(TOKEN);
    const r = await clientRuntimeCall(t, { method: 'POST', path: `${API}/build?t=${encodeURIComponent(TAG)}&dockerfile=Containerfile&layers=true&rm=true`, tar: tar(FILE), timeoutMs: 30 * 60_000 });
    expect(r.status).toBe(200);
    expect(libpod.builds.get(TAG)).toBe(FILE);

    const d = await api([on('POST', '/v1.41/build', { status: 200, text: '{"stream":"done"}\n' })]);
    await c!.stop();
    const td = (await client({ docker: d.socket })).transport(TOKEN);
    expect((await clientRuntimeCall(td, { method: 'POST', path: `/v1.41/build?t=${encodeURIComponent(TAG)}&dockerfile=Containerfile&rm=1`, tar: tar(FILE) })).status).toBe(200);
    expect(String(d.seen[0]!.body)).toContain(FILE);
  });

  it('a build of anything but a tools image, with other build options, or of another context, is refused', async () => {
    const a = await api(createFakeLibpod().handlers);
    const t = (await client({ podman: a.socket })).transport(TOKEN);
    const at = (q: string): string => `${API}/build?${q}`;
    const good = `t=${encodeURIComponent(TAG)}&dockerfile=Containerfile&layers=true&rm=true`;
    const two = Buffer.concat([containerfileTar(FILE).subarray(0, 1024), containerfileTar('FROM y\n')]);
    const named = containerfileTar(FILE);
    named.write('etc/passwd\0\0\0\0', 0, 'ascii');
    for (const [path, call, why] of [
      [at(`t=${encodeURIComponent('example.org/kube-box:1')}&dockerfile=Containerfile&layers=true&rm=true`), { tar: tar(FILE) }, 'tools image'],
      [at(`${good}&networkmode=host`), { tar: tar(FILE) }, 'networkmode'],
      [at(`${good}&volume=${encodeURIComponent('/:/host')}`), { tar: tar(FILE) }, 'volume'],
      [at(good.replace('dockerfile=Containerfile', 'dockerfile=Other')), { tar: tar(FILE) }, 'dockerfile'],
      [at(good), {}, 'a tar of its Containerfile'],
      [at(good), { body: { remote: 'https://example.org/context.tar' } }, 'a tar of its Containerfile'],
      [at(good), { tar: two.toString('base64') }, 'one file'],
      [at(good), { tar: named.toString('base64') }, 'one file'],
      [at(good), { tar: 'not a tar' }, 'one file'],
    ] as const) {
      const r = await clientRuntimeCall(t, { method: 'POST', path, ...call });
      expect(r.status, why).toBe(403);
      expect(JSON.parse(r.text).message).toContain(why);
    }
    expect(a.seen).toEqual([]);
  });
});

describe('the read-only check on the machine (issue #708)', () => {
  it('a check box is carried: its script, its end awaited, and its output as the bytes the runtime sent', async () => {
    const libpod = createFakeLibpod();
    const a = await api(libpod.handlers);
    const t = (await client({ podman: a.socket })).transport(TOKEN);
    const made = await clientRuntimeCall(t, { method: 'POST', path: `${API}/containers/create`, body: libpodCreateBody(checkSpec) });
    expect(made.status).toBe(201);
    const id = (JSON.parse(made.text) as { Id: string }).Id;
    expect(libpod.containers.get(id)!.body).toMatchObject({ entrypoint: ['/bin/sh'], command: ['-c', 'echo HOPPER-PROBE'], terminal: true, restart_policy: 'no' });
    // A frame longer than 127 bytes: its length is no UTF-8 text, so only the bytes as sent keep it.
    libpod.containers.get(id)!.run = { exit: 3, logs: LOGS };
    await clientRuntimeCall(t, { method: 'POST', path: `${API}/containers/${id}/start` });
    const ended = await clientRuntimeCall(t, { method: 'POST', path: `${API}/containers/${id}/wait?condition=exited&condition=stopped`, timeoutMs: 30 * 60_000 });
    expect(ended).toMatchObject({ status: 200, text: '3' });
    const logs = await clientRuntimeCall(t, { method: 'GET', path: `${API}/containers/${id}/logs?stdout=true&stderr=true` });
    expect(logs.status).toBe(200);
    expect(Buffer.from(logs.base64!, 'base64').equals(LOGS)).toBe(true);
    expect((await clientRuntimeCall(t, { method: 'DELETE', path: `${API}/volumes/${checkSpec.volume}?force=true` })).status).toBe(404);
    expect((await clientRuntimeCall(t, { method: 'DELETE', path: `${API}/containers/${id}?force=true&timeout=10` })).status).toBe(204);
  });

  it('a script on a sandbox box, a check box without its one script, and a wait or a read of a sandbox box are refused', async () => {
    const libpod = createFakeLibpod();
    const a = await api(libpod.handlers);
    const t = (await client({ podman: a.socket })).transport(TOKEN);
    const check = libpodCreateBody(checkSpec);
    const { entrypoint: _e, command: _c, terminal: _t, ...noScript } = check;
    for (const [body, why] of [
      [libpodCreateBody({ ...spec, script: 'id' }), "its image's own entrypoint"],
      [{ ...noScript, restart_policy: 'unless-stopped' }, 'runs its script once'],
      [{ ...check, entrypoint: ['/bin/bash'] }, 'runs its script once'],
      [{ ...check, command: ['-c', 'id', 'more'] }, 'runs its script once'],
      [{ ...check, restart_policy: 'always' }, 'runs its script once'],
      [{ ...check, name: 'hopper-sandbox-kube' }, 'hopper-check-'],
      [{ ...check, cap_drop: [] }, 'every capability dropped'],
    ] as const) {
      const r = await clientRuntimeCall(t, { method: 'POST', path: `${API}/containers/create`, body });
      expect(r.status, why).toBe(403);
      expect(JSON.parse(r.text).message).toContain(why);
    }
    expect(a.seen.filter((s) => s.path.endsWith('/containers/create'))).toEqual([]);
    const box = (JSON.parse((await clientRuntimeCall(t, { method: 'POST', path: `${API}/containers/create`, body: libpodCreateBody(spec) })).text) as { Id: string }).Id;
    const theirs = libpod.put({ name: 'postgres', image: 'postgres', labels: {} });
    for (const id of [box, theirs]) {
      for (const [method, path] of [['POST', `/containers/${id}/wait`], ['GET', `/containers/${id}/logs?stdout=true&stderr=true`]] as const) {
        const r = await clientRuntimeCall(t, { method, path: API + path });
        expect(r.status).toBe(403);
        expect(r.base64).toBeUndefined();
      }
    }
    expect(a.seen.filter((s) => /\/(wait|logs)$/.test(s.path))).toEqual([]);
  });
});

const checkSpec = {
  ...spec, name: 'hopper-check-asked-1', volume: 'hopper-check-asked-1-home', env: {}, labels: { 'io.hopper.check': 'i-1', 'io.hopper.user': 'admin' },
  script: 'echo HOPPER-PROBE',
};
const frame = (s: string): Buffer => { const b = Buffer.from(s); const h = Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]); h.writeUInt32BE(b.length, 4); return Buffer.concat([h, b]); };
const LOGS = Buffer.concat([frame('HOPPER-PROBE 0 1 '), frame('x'.repeat(200)), frame('\r\n')]);

const TAG = 'localhost/hopper-box-tools:0123456789abcdef';
const FILE = 'FROM example.org/kube-box:1\nLABEL io.hopper.tools="kubectl"\n';
const tar = (containerfile: string): string => containerfileTar(containerfile).toString('base64');
