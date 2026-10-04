// Issue #18, "Cant add machines": the Machines view adds, edits and removes attached machines
// through POST /ui/api/machines, which writes plugins.yaml `attachedMachines:` and applies without
// a restart. The ssh target is chosen from ~/.ssh/config's Host aliases, never typed; herdrBin is
// resolved over ssh by the daemon (the seam here), never sent by the UI. Real HTTP server, real
// plugins.yaml in the sealed HOME.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MachinesConfig } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

type Reply = MachinesConfig & { error: string };

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;
const resolved: string[] = [];

beforeEach(() => {
  mkdirSync(join(homedir(), '.ssh'), { recursive: true, mode: 0o700 });
  writeFileSync(join(homedir(), '.ssh', 'config'), 'Host laptop\n  HostName 192.0.2.10\nHost desk unreachable\nHost *.lan\n');
  resolved.length = 0;
});

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

const FILE = `version: 1
# the owner's note: kept across UI edits
executors:
  - { name: test, plugin: test }
  - { name: herdr-claude, plugin: herdr-claude }
jobSources: []
attachedMachines:
  - { name: desk, ssh: desk, lanes: 1, executors: [test], herdrBin: /usr/bin/herdr }   # the desk
`;

async function start(file = FILE): Promise<{ a: TestApp; token: string; path: string }> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const path = join(dirname(db.dbPath), 'plugins.yaml');
  writeFileSync(path, file, { mode: 0o600 });
  t = await startTestApp({
    dbPath: db.dbPath,
    seams: {
      machineProbe: async () => true,
      resolveHerdrBin: async (ssh) => {
        resolved.push(ssh);
        if (ssh === 'unreachable') throw new Error('ssh unreachable: No route to host');
        return `/home/h/.local/bin/herdr`;
      },
    },
  });
  return { a: t, token: await t.login(), path };
}

const config = async (a: TestApp): Promise<MachinesConfig> => (await a.api('GET', '/api/machines/config')).body;
const machineIds = async (a: TestApp): Promise<string[]> => (await a.api('GET', '/api/machines')).body.machines.map((m: { id: string }) => m.id);
const read = (path: string) => readFileSync(path, 'utf8');

describe('GET /api/machines/config', () => {
  it('the attached machines as configured, the executors they may run, the detected ssh targets and the file version', async () => {
    const { a } = await start();
    const c = await config(a);
    expect(c.version).toMatch(/^[0-9a-f]{64}$/);
    expect(c.attached).toEqual([{ name: 'desk', ssh: 'desk', lanes: 1, executors: ['test'], herdrBin: '/usr/bin/herdr', session: 'job-hopper' }]);
    expect(c.executors).toEqual(['test', 'herdr-claude']);
    expect(c.machine).toMatchObject({ name: 'local', plugin: 'local' });
    expect(c.ssh.targets).toEqual(['laptop', 'desk', 'unreachable']);
  });
});

describe('POST /ui/api/machines — add', () => {
  it('without a UI session: 403, nothing written', async () => {
    const { a, path } = await start();
    const before = read(path);
    const r = await a.ui('/ui/api/machines', { action: 'add', name: 'laptop', ssh: 'laptop', lanes: 2, version: (await config(a)).version });
    expect(r.status).toBe(403);
    expect(read(path)).toBe(before);
  });

  it('writes one entry with the resolved herdrBin, keeps every other byte, mode 600; /api/machines lists it without a restart', async () => {
    const { a, token, path } = await start();
    const r = await a.ui<Reply>('/ui/api/machines', {
      action: 'add', name: 'laptop', ssh: 'laptop', lanes: 2, executors: ['herdr-claude', 'test'], label: 'arch laptop', version: (await config(a)).version,
    }, { token });
    expect(r.status).toBe(200);
    expect(resolved).toEqual(['laptop']);
    const text = read(path);
    expect(text.startsWith(FILE)).toBe(true);
    expect(parse(text).attachedMachines[1]).toEqual({ name: 'laptop', ssh: 'laptop', lanes: 2, executors: ['herdr-claude', 'test'], label: 'arch laptop', herdrBin: '/home/h/.local/bin/herdr' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(r.body.attached.map((m) => m.name)).toEqual(['desk', 'laptop']);
    expect(await machineIds(a)).toEqual(['local', 'desk', 'laptop']);
    await waitFor(async () => (await a.api('GET', '/api/machines')).body.machines.find((m: { id: string; online: boolean }) => m.id === 'laptop' && m.online));
  });

  it('into a file with no attachedMachines section: the section is added', async () => {
    const { a, token, path } = await start('version: 1\nexecutors: [ { name: test, plugin: test } ]\n');
    const r = await a.ui<Reply>('/ui/api/machines', { action: 'add', name: 'laptop', ssh: 'laptop', lanes: 1, executors: ['test'], version: (await config(a)).version }, { token });
    expect(r.status).toBe(200);
    expect(parse(read(path)).attachedMachines).toEqual([{ name: 'laptop', ssh: 'laptop', lanes: 1, executors: ['test'], herdrBin: '/home/h/.local/bin/herdr' }]);
  });

  it('an ssh target not among the detected Host aliases: 400, never probed, nothing written', async () => {
    const { a, token, path } = await start();
    const before = read(path);
    for (const ssh of ['owner@10.0.0.9', 'x.lan', '-oProxyCommand=sh']) {
      const r = await a.ui<Reply>('/ui/api/machines', { action: 'add', name: 'x', ssh, lanes: 1, version: (await config(a)).version }, { token });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/ssh/);
    }
    expect(resolved).toEqual([]);
    expect(read(path)).toBe(before);
  });

  it('herdrBin and session are never taken from the UI: 400', async () => {
    const { a, token } = await start();
    const version = (await config(a)).version;
    expect((await a.ui('/ui/api/machines', { action: 'add', name: 'laptop', ssh: 'laptop', lanes: 1, herdrBin: '/tmp/evil', version }, { token })).status).toBe(400);
    expect((await a.ui('/ui/api/machines', { action: 'add', name: 'laptop', ssh: 'laptop', lanes: 1, session: 'default', version }, { token })).status).toBe(400);
  });

  it('herdr cannot be resolved there: 409 with the reason, nothing written', async () => {
    const { a, token, path } = await start();
    const before = read(path);
    const r = await a.ui<Reply>('/ui/api/machines', { action: 'add', name: 'gone', ssh: 'unreachable', lanes: 1, executors: ['test'], version: (await config(a)).version }, { token });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/No route to host/);
    expect(read(path)).toBe(before);
    expect(await machineIds(a)).toEqual(['local', 'desk']);
  });

  it('refused by the attachedMachines rules: local, the machine source\'s name, a name taken, lanes < 1, an unknown executor', async () => {
    const { a, token, path } = await start();
    const before = read(path);
    const version = (await config(a)).version;
    const add = (over: Record<string, unknown>) => a.ui<Reply>('/ui/api/machines', { action: 'add', name: 'laptop', ssh: 'laptop', lanes: 1, executors: ['test'], version, ...over }, { token });
    expect((await add({ name: 'local' })).status).toBe(400);
    expect((await add({ name: 'desk' })).status).toBe(409);
    expect((await add({ lanes: 0 })).status).toBe(400);
    const unknown = await add({ executors: ['nope'] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatch(/nope/);
    expect(read(path)).toBe(before);
  });

  it('a stale version: 409, nothing written', async () => {
    const { a, token, path } = await start();
    const version = (await config(a)).version;
    writeFileSync(path, `${FILE}# edited by hand\n`, { mode: 0o600 });
    const r = await a.ui<Reply>('/ui/api/machines', { action: 'add', name: 'laptop', ssh: 'laptop', lanes: 1, executors: ['test'], version }, { token });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/changed since it was read/);
    expect(read(path)).toBe(`${FILE}# edited by hand\n`);
  });
});

describe('POST /ui/api/machines — edit', () => {
  it('lanes, executors and label change in place; ssh, herdrBin and session stay; applies without a restart', async () => {
    const { a, token, path } = await start();
    const r = await a.ui<Reply>('/ui/api/machines', { action: 'edit', name: 'desk', lanes: 3, executors: ['test', 'herdr-claude'], label: 'the desk', version: (await config(a)).version }, { token });
    expect(r.status).toBe(200);
    const text = read(path);
    const desk = /^ {2}- \{ name: desk.*$/m;
    expect(text.replace(desk, '')).toBe(FILE.replace(desk, ''));
    expect(parse(text).attachedMachines).toEqual([{ name: 'desk', ssh: 'desk', lanes: 3, executors: ['test', 'herdr-claude'], label: 'the desk', herdrBin: '/usr/bin/herdr' }]);
    const live = (await a.api('GET', '/api/machines')).body.machines.find((m: { id: string }) => m.id === 'desk');
    expect(live).toMatchObject({ maxLanes: 3, label: 'the desk', executors: ['test', 'herdr-claude'] });
  });

  it('a null label goes back to the name', async () => {
    const { a, token, path } = await start(FILE.replace('lanes: 1,', 'lanes: 1, label: old,'));
    const r = await a.ui<Reply>('/ui/api/machines', { action: 'edit', name: 'desk', label: null, version: (await config(a)).version }, { token });
    expect(r.status).toBe(200);
    expect(parse(read(path)).attachedMachines[0].label).toBeUndefined();
  });

  it('cannot change ssh, herdrBin or session (400); an unknown machine is 404', async () => {
    const { a, token } = await start();
    const version = (await config(a)).version;
    for (const over of [{ ssh: 'laptop' }, { herdrBin: '/tmp/x' }, { session: 'other' }]) {
      expect((await a.ui('/ui/api/machines', { action: 'edit', name: 'desk', version, ...over }, { token })).status).toBe(400);
    }
    expect((await a.ui('/ui/api/machines', { action: 'edit', name: 'nope', lanes: 2, version }, { token })).status).toBe(404);
  });
});

describe('POST /ui/api/machines — remove', () => {
  it('removes the entry; /api/machines no longer lists it, without a restart', async () => {
    const { a, token, path } = await start();
    const r = await a.ui<Reply>('/ui/api/machines', { action: 'remove', name: 'desk', version: (await config(a)).version }, { token });
    expect(r.status).toBe(200);
    expect(parse(read(path)).attachedMachines).toEqual([]);
    expect(read(path)).toContain("# the owner's note: kept across UI edits");
    expect(await machineIds(a)).toEqual(['local']);
  });

  it('refused (409, naming the jobs) while a lane there is busy or a job waits for an answer in a pane there', async () => {
    const { a, token, path } = await start();
    const before = read(path);
    const store = a.app.store;
    const parked = store.jobs.create({ executor: 'test', payload: {} }, 50);
    store.jobs.update(parked.id, { status: 'waiting_answer', resumeOn: 'desk' });
    const r = await a.ui<Reply>('/ui/api/machines', { action: 'remove', name: 'desk', version: (await config(a)).version }, { token });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain(parked.id);
    expect(read(path)).toBe(before);

    store.jobs.update(parked.id, { status: 'cancelled', resumeOn: undefined });
    const running = store.jobs.create({ executor: 'test', payload: {} }, 50);
    store.jobs.update(running.id, { status: 'running' });
    const lane = store.lanes.open('desk');
    store.lanes.update(lane.id, { state: 'busy', jobId: running.id });
    const busy = await a.ui<Reply>('/ui/api/machines', { action: 'remove', name: 'desk', version: (await config(a)).version }, { token });
    expect(busy.status).toBe(409);
    expect(busy.body.error).toContain(running.id);
  });
});
