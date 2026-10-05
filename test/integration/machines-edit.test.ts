// Issues #18 and #74: an attached machine is a machine-source instance (plugins.yaml `machines:`).
// The Machines view attaches one over ssh through POST /ui/api/machines — the ssh target chosen from
// ~/.ssh/config's Host aliases, never typed; herdrBin and the host key resolved by the daemon (the
// seam here), never sent by the UI — and edits or removes any machine through POST /ui/api/plugins,
// like every other plugin instance. Each applies without a restart. Real HTTP server, the
// plugins.yaml document in the database, the sealed HOME.
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MachinesConfig, PluginsReport } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, writePluginsYaml, type TestApp } from '../support/app.ts';
import { readDocument } from '../support/files.ts';
import { waitFor } from '../support/wait.ts';
import { TEST_HOST_KEY } from '../support/ssh.ts';

type Reply = MachinesConfig & { error: string };
type PluginsReply = PluginsReport & { error: string };

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;
const resolved: string[] = [];
const withHerdr: boolean[] = [];

beforeEach(() => {
  mkdirSync(join(homedir(), '.ssh'), { recursive: true, mode: 0o700 });
  writeFileSync(join(homedir(), '.ssh', 'config'), 'Host laptop\n  HostName 192.0.2.10\nHost desk unreachable\nHost *.lan\n');
  resolved.length = 0;
  withHerdr.length = 0;
});

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

const FILE = `version: 1
# The owner's note: kept across UI edits
executors:
  - { name: test, plugin: test }
  - { name: herdr-claude, plugin: herdr-claude }
jobSources: []
machines:
  - { name: local, plugin: local }
  # the desk
  - { name: desk, plugin: ssh, options: { ssh: desk, lanes: 1, executors: [test], herdrBin: /usr/bin/herdr } }
`;

async function start(file = FILE): Promise<{ a: TestApp; token: string }> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  writePluginsYaml(db.dbPath, file);
  t = await startTestApp({
    dbPath: db.dbPath,
    seams: {
      machineProbe: async () => ({ online: true }),
      resolveTarget: async (ssh, o) => {
        resolved.push(ssh);
        withHerdr.push(o.herdr);
        if (ssh === 'unreachable') throw new Error('ssh unreachable: No route to host');
        return o.herdr ? { herdrBin: `/home/user/.local/bin/herdr`, hostKey: TEST_HOST_KEY } : { hostKey: TEST_HOST_KEY };
      },
    },
  });
  return { a: t, token: await t.login() };
}

const config = async (a: TestApp): Promise<MachinesConfig> => (await a.api('GET', '/api/machines/config')).body;
const machineIds = async (a: TestApp): Promise<string[]> => (await a.api('GET', '/api/machines')).body.machines.map((m: { id: string }) => m.id);
const read = (a: TestApp) => readDocument(a.dbPath, 'plugins.yaml')!;
const plugins = (a: TestApp, token: string, edit: Record<string, unknown>) => a.ui<PluginsReply>('/ui/api/plugins', edit, { token });

describe('GET /api/machines/config', () => {
  it('every machine-source instance as configured, the executors a machine may run, the detected ssh targets and the document version', async () => {
    const { a } = await start();
    const c = await config(a);
    expect(c.version).toMatch(/^[0-9a-f]{64}$/);
    expect(c.machines).toEqual([
      { name: 'local', plugin: 'local', options: {} },
      { name: 'desk', plugin: 'ssh', options: { ssh: 'desk', lanes: 1, executors: ['test'], herdrBin: '/usr/bin/herdr' } },
    ]);
    expect(c.executors).toEqual(['test', 'herdr-claude']);
    expect(c.ssh.targets).toEqual(['laptop', 'desk', 'unreachable']);
  });

  it('the Plugins view lists them as machine-source instances, the attached one with its plugin ssh', async () => {
    const { a } = await start();
    const report = (await a.api('GET', '/api/plugins')).body as PluginsReport;
    expect(report.instances.filter((i) => i.role === 'machine-source').map((i) => `${i.instance.name}:${i.instance.plugin}`)).toEqual(['local:local', 'desk:ssh']);
    const ssh = report.plugins.find((p) => p.id === 'ssh')!.options as { properties: Record<string, { commandBearing?: boolean }> };
    expect(Object.entries(ssh.properties).filter(([, p]) => p.commandBearing).map(([k]) => k).sort()).toEqual(['herdr', 'herdrBin', 'hostKey', 'session', 'ssh']);
  });
});

describe('POST /ui/api/machines — attach over ssh', () => {
  it('without a UI session: 403, nothing written', async () => {
    const { a } = await start();
    const before = read(a);
    const r = await a.ui('/ui/api/machines', { name: 'laptop', ssh: 'laptop', lanes: 2, version: (await config(a)).version });
    expect(r.status).toBe(403);
    expect(read(a)).toBe(before);
  });

  it('adds an ssh instance with the resolved herdrBin and the pinned host key, keeps the comments; /api/machines lists it without a restart', async () => {
    const { a, token } = await start();
    const r = await a.ui<Reply>('/ui/api/machines', {
      name: 'laptop', ssh: 'laptop', lanes: 2, executors: ['herdr-claude', 'test'], label: 'spare laptop', version: (await config(a)).version,
    }, { token });
    expect(r.status).toBe(200);
    expect(resolved).toEqual(['laptop']);
    const text = read(a);
    expect(text).toContain("# The owner's note: kept across UI edits");
    expect(text).toContain('# the desk');
    expect(parse(text).machines[2]).toEqual({
      name: 'laptop', plugin: 'ssh',
      options: { label: 'spare laptop', ssh: 'laptop', lanes: 2, executors: ['herdr-claude', 'test'], herdrBin: '/home/user/.local/bin/herdr', hostKey: TEST_HOST_KEY },
    });
    expect(r.body.machines.map((m) => m.name)).toEqual(['local', 'desk', 'laptop']);
    expect(await machineIds(a)).toEqual(['local', 'desk', 'laptop']);
    await waitFor(async () => (await a.api('GET', '/api/machines')).body.machines.find((m: { id: string; online: boolean }) => m.id === 'laptop' && m.online));
  });

  it('into a document with no machines section: the built-in local is written first', async () => {
    const { a, token } = await start('version: 1\nexecutors: [ { name: test, plugin: test }, { name: herdr-claude, plugin: herdr-claude } ]\n');
    const r = await a.ui<Reply>('/ui/api/machines', { name: 'laptop', ssh: 'laptop', lanes: 1, executors: ['herdr-claude'], version: (await config(a)).version }, { token });
    expect(r.status).toBe(200);
    expect(parse(read(a)).machines).toEqual([
      { name: 'local', plugin: 'local', options: { lanes: 4 } },
      { name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', lanes: 1, executors: ['herdr-claude'], herdrBin: '/home/user/.local/bin/herdr', hostKey: TEST_HOST_KEY } },
    ]);
  });

  it('a machine none of whose executors uses herdr runs no herdr (issue #142): herdr is not looked for, only the host key and the connection', async () => {
    const { a, token } = await start(FILE.replace('jobSources: []', '  - { name: cursor, plugin: cursor-agent }\njobSources: []'));
    const r = await a.ui<Reply>('/ui/api/machines', { name: 'wsl', ssh: 'laptop', lanes: 1, executors: ['cursor', 'test'], version: (await config(a)).version }, { token });
    expect(r.status).toBe(200);
    expect(withHerdr).toEqual([false]);
    expect(parse(read(a)).machines[2]).toEqual({
      name: 'wsl', plugin: 'ssh', options: { ssh: 'laptop', lanes: 1, executors: ['cursor', 'test'], herdr: false, hostKey: TEST_HOST_KEY },
    });
    await waitFor(async () => (await a.api('GET', '/api/machines')).body.machines.find((m: { id: string; online: boolean }) => m.id === 'wsl' && m.online));
  });

  it('an ssh target not among the detected Host aliases: 400, never probed, nothing written', async () => {
    const { a, token } = await start();
    const before = read(a);
    for (const ssh of ['user@10.0.0.9', 'x.lan', '-oProxyCommand=sh']) {
      const r = await a.ui<Reply>('/ui/api/machines', { name: 'x', ssh, lanes: 1, version: (await config(a)).version }, { token });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/ssh/);
    }
    expect(resolved).toEqual([]);
    expect(read(a)).toBe(before);
  });

  it('herdrBin, session and the host key are never taken from the UI: 400', async () => {
    const { a, token } = await start();
    const version = (await config(a)).version;
    expect((await a.ui('/ui/api/machines', { name: 'laptop', ssh: 'laptop', lanes: 1, herdrBin: '/tmp/evil', version }, { token })).status).toBe(400);
    expect((await a.ui('/ui/api/machines', { name: 'laptop', ssh: 'laptop', lanes: 1, session: 'default', version }, { token })).status).toBe(400);
    expect((await a.ui('/ui/api/machines', { name: 'laptop', ssh: 'laptop', lanes: 1, hostKey: TEST_HOST_KEY, version }, { token })).status).toBe(400);
  });

  it('the machine cannot be reached, or herdr not resolved there: 409 with the reason, nothing written', async () => {
    const { a, token } = await start();
    const before = read(a);
    const r = await a.ui<Reply>('/ui/api/machines', { name: 'gone', ssh: 'unreachable', lanes: 1, executors: ['herdr-claude'], version: (await config(a)).version }, { token });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/No route to host/);
    expect(read(a)).toBe(before);
    expect(await machineIds(a)).toEqual(['local', 'desk']);
  });

  it('refused: a name another machine has, lanes < 1, an unknown executor', async () => {
    const { a, token } = await start();
    const before = read(a);
    const version = (await config(a)).version;
    const add = (over: Record<string, unknown>) => a.ui<Reply>('/ui/api/machines', { name: 'laptop', ssh: 'laptop', lanes: 1, executors: ['test'], version, ...over }, { token });
    expect((await add({ name: 'local' })).status).toBe(409);
    expect((await add({ name: 'desk' })).status).toBe(409);
    expect((await add({ lanes: 0 })).status).toBe(400);
    const unknown = await add({ executors: ['nope'] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatch(/nope/);
    expect(read(a)).toBe(before);
  });

  it('a stale version: 409, nothing written', async () => {
    const { a, token } = await start();
    const version = (await config(a)).version;
    writePluginsYaml(a.dbPath, `${FILE}# edited by hand\n`);
    const r = await a.ui<Reply>('/ui/api/machines', { name: 'laptop', ssh: 'laptop', lanes: 1, executors: ['test'], version }, { token });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/changed since it was read/);
    expect(read(a)).toBe(`${FILE}# edited by hand\n`);
  });
});

// Issue #142: what a new machine starts with — its lanes and the executors it runs — is plugins.yaml
// `machineDefaults:`, edited in the Machines view; absent, one lane and herdr-claude.
describe('machine defaults', () => {
  it('absent: one lane and herdr-claude; the config reports them', async () => {
    const { a } = await start();
    expect((await config(a)).defaults).toEqual({ lanes: 1, executors: ['herdr-claude'] });
  });

  it('POST /ui/api/machines/defaults writes machineDefaults, keeps the comments, and a machine attached without lanes or executors takes them', async () => {
    const { a, token } = await start();
    const r = await a.ui<Reply>('/ui/api/machines/defaults', { lanes: 3, executors: ['test'], version: (await config(a)).version }, { token });
    expect(r.status).toBe(200);
    expect(r.body.defaults).toEqual({ lanes: 3, executors: ['test'] });
    const text = read(a);
    expect(text).toContain("# The owner's note: kept across UI edits");
    expect(parse(text).machineDefaults).toEqual({ lanes: 3, executors: ['test'] });
    const added = await a.ui<Reply>('/ui/api/machines', { name: 'laptop', ssh: 'laptop', version: r.body.version }, { token });
    expect(added.status).toBe(200);
    expect(parse(read(a)).machines[2].options).toEqual({ ssh: 'laptop', lanes: 3, executors: ['test'], herdr: false, hostKey: TEST_HOST_KEY });
  });

  it('refused: no UI session (403), lanes < 1 or an executor that is not configured (400), a stale version (409); nothing written', async () => {
    const { a, token } = await start();
    const before = read(a);
    const version = (await config(a)).version;
    expect((await a.ui('/ui/api/machines/defaults', { lanes: 2, executors: ['test'], version })).status).toBe(403);
    expect((await a.ui('/ui/api/machines/defaults', { lanes: 0, executors: ['test'], version }, { token })).status).toBe(400);
    const unknown = await a.ui<Reply>('/ui/api/machines/defaults', { lanes: 1, executors: ['nope'], version }, { token });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatch(/nope/);
    expect((await a.ui('/ui/api/machines/defaults', { lanes: 1, executors: ['test'], version: 'stale' }, { token })).status).toBe(409);
    expect(read(a)).toBe(before);
  });
});

describe('POST /ui/api/plugins — an attached machine\'s options', () => {
  it('lanes, executors and label change in place; ssh and herdrBin stay; applies without a restart', async () => {
    const { a, token } = await start();
    const version = (await config(a)).version;
    const r = await plugins(a, token, {
      action: 'options', role: 'machine-source', name: 'desk', version,
      options: { ssh: 'desk', herdrBin: '/usr/bin/herdr', lanes: 3, executors: ['test', 'herdr-claude'], label: 'the desk' },
    });
    expect(r.status).toBe(200);
    const text = read(a);
    expect(text).toContain('# the desk');
    expect(parse(text).machines[1]).toEqual({ name: 'desk', plugin: 'ssh', options: { ssh: 'desk', herdrBin: '/usr/bin/herdr', lanes: 3, executors: ['test', 'herdr-claude'], label: 'the desk' } });
    await waitFor(async () => (await a.api('GET', '/api/machines')).body.machines.find((m: { id: string; maxLanes: number }) => m.id === 'desk' && m.maxLanes === 3));
    const live = (await a.api('GET', '/api/machines')).body.machines.find((m: { id: string }) => m.id === 'desk');
    expect(live).toMatchObject({ maxLanes: 3, label: 'the desk', executors: ['test', 'herdr-claude'], online: true });
  });

  it('ssh, herdrBin, session or the host key cannot change from the UI: 409, nothing written', async () => {
    const { a, token } = await start();
    const before = read(a);
    const version = (await config(a)).version;
    const base = { ssh: 'desk', herdrBin: '/usr/bin/herdr', lanes: 1, executors: ['test'] };
    for (const over of [{ ssh: 'laptop' }, { herdrBin: '/tmp/x' }, { session: 'other' }, { hostKey: TEST_HOST_KEY }]) {
      const r = await plugins(a, token, { action: 'options', role: 'machine-source', name: 'desk', version, options: { ...base, ...over } });
      expect(r.status).toBe(409);
    }
    expect(read(a)).toBe(before);
  });
});

describe('POST /ui/api/plugins — remove a machine', () => {
  it('removes the instance; /api/machines no longer lists it, without a restart', async () => {
    const { a, token } = await start();
    const r = await plugins(a, token, { action: 'remove', role: 'machine-source', name: 'desk', version: (await config(a)).version });
    expect(r.status).toBe(200);
    expect(parse(read(a)).machines).toEqual([{ name: 'local', plugin: 'local' }]);
    expect(read(a)).toContain("# The owner's note: kept across UI edits");
    expect(await machineIds(a)).toEqual(['local']);
  });

  it('refused (409, naming the jobs) while a lane there is busy or a job waits for an answer in a pane there', async () => {
    const { a, token } = await start();
    const before = read(a);
    const store = a.user().store;
    const parked = store.jobs.create({ executor: 'test', payload: {} }, 50);
    store.jobs.update(parked.id, { status: 'waiting_answer', resumeOn: 'desk' });
    const r = await plugins(a, token, { action: 'remove', role: 'machine-source', name: 'desk', version: (await config(a)).version });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain(parked.id);
    expect(read(a)).toBe(before);

    store.jobs.update(parked.id, { status: 'cancelled', resumeOn: undefined });
    const running = store.jobs.create({ executor: 'test', payload: {} }, 50);
    const lane = store.lanes.open('desk');
    store.jobs.update(running.id, { status: 'running', laneId: lane.id });
    store.lanes.update(lane.id, { state: 'busy', jobId: running.id });
    const busy = await plugins(a, token, { action: 'remove', role: 'machine-source', name: 'desk', version: (await config(a)).version });
    expect(busy.status).toBe(409);
    expect(busy.body.error).toContain(running.id);
  });
});
