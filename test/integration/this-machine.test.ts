// Issue #260: this machine is added from the Machines view like any other — no ssh target, a name, and
// the herdr session its jobs run in, which the hopper starts (the seam here). Parts that run on a machine
// and name none (escalation levels, usage sources) run on it. Real HTTP server, the plugins config in the
// database, the sealed HOME.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MachinesConfig } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, writePlugins, type TestApp } from '../support/app.ts';
import { readConfig } from '../support/files.ts';
import { waitFor } from '../support/wait.ts';

type Reply = MachinesConfig & { error: string };

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;
const resolved: string[] = [];
const sessions: string[] = [];
let sessionFails = false;

beforeEach(() => {
  resolved.length = 0;
  sessions.length = 0;
  sessionFails = false;
});

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

const DESK = { name: 'desk', plugin: 'ssh', options: { ssh: 'desk', lanes: 1, executors: ['test'], herdrBin: '/usr/bin/herdr' } };
const FILE = { version: 1, executors: [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude' }], jobSources: [], machines: [{ name: 'local', plugin: 'local' }, DESK] };

async function start(file: object = FILE): Promise<{ a: TestApp; token: string }> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  writePlugins(db.dbPath, file);
  t = await startTestApp({
    dbPath: db.dbPath,
    seams: {
      machineProbe: async () => ({ online: true }),
      resolveTarget: async (ssh) => { resolved.push(ssh); throw new Error('never reached over ssh'); },
      herdrSession: async (session) => {
        if (sessionFails) throw new Error('herdr not found: herdr');
        sessions.push(session);
      },
    },
  });
  return { a: t, token: await t.login() };
}

const config = async (a: TestApp): Promise<MachinesConfig> => (await a.api('GET', '/api/machines/config')).body;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON
const read = (a: TestApp) => readConfig(a.dbPath, 'plugins') as any;

describe('POST /ui/api/machines — this machine', () => {
  const NONE = { ...FILE, machines: [DESK] };

  it('adds a local instance under the name given, with its herdr session, and starts that session; no ssh target, nothing reached over ssh', async () => {
    const { a, token } = await start(NONE);
    const r = await a.ui<Reply>('/ui/api/machines', { name: 'archbox', session: 'jobs', lanes: 3, version: (await config(a)).version }, { token });
    expect(r.status).toBe(200);
    expect(resolved).toEqual([]);
    expect(sessions).toContain('jobs');
    expect(read(a).machines).toEqual([DESK, { name: 'archbox', plugin: 'local', options: { lanes: 3, session: 'jobs' } }]);
    expect(r.body.machines.find((m) => m.name === 'archbox')).toEqual({ name: 'archbox', connection: 'local', options: { lanes: 3, session: 'jobs' } });
    await waitFor(async () => (await a.api('GET', '/api/machines')).body.machines.find((m: { id: string; online: boolean }) => m.id === 'archbox' && m.online));
    const listed = (await a.api('GET', '/api/machines')).body.machines.find((m: { id: string }) => m.id === 'archbox');
    expect(listed.herdr).toMatchObject({ session: 'jobs' });
    expect(listed.ssh).toBeUndefined();
  });

  it('no session given: the hopper session; no lanes given: four', async () => {
    const { a, token } = await start(NONE);
    const r = await a.ui<Reply>('/ui/api/machines', { name: 'here', version: (await config(a)).version }, { token });
    expect(r.status).toBe(200);
    expect(sessions).toContain('hopper');
    expect(read(a).machines[1]).toEqual({ name: 'here', plugin: 'local', options: { lanes: 4, session: 'hopper' } });
  });

  it('escalation levels and usage sources that name no machine run on it; one that names a machine keeps it', async () => {
    const { a, token } = await start({
      ...NONE,
      escalationLevels: [
        { name: 'level-1', plugin: 'claude-cli', options: { bin: 'claude', model: 'opus' } },
        { name: 'level-2', plugin: 'claude-cli', options: { bin: 'claude', model: 'fable', machine: 'desk' } },
      ],
      usageSources: [{ name: 'claude', plugin: 'claude-plan', options: { bin: 'claude', intervalSeconds: 600 } }],
    });
    const r = await a.ui<Reply>('/ui/api/machines', { name: 'archbox', version: (await config(a)).version }, { token });
    expect(r.status).toBe(200);
    const doc = read(a);
    expect(doc.escalationLevels.map((l: { options: { machine?: string } }) => l.options.machine)).toEqual(['archbox', 'desk']);
    expect(doc.usageSources[0].options.machine).toBe('archbox');
  });

  it('refused: this machine is already added, a name another machine has, the default herdr session, a session name that is not plain', async () => {
    const { a, token } = await start();
    const before = read(a);
    const version = (await config(a)).version;
    const again = await a.ui<Reply>('/ui/api/machines', { name: 'here', version }, { token });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/this machine is already added, as local/);
    const { a: b, token: t2 } = await (async () => { await t?.stop(); cleanup?.(); return start(NONE); })();
    const v2 = (await config(b)).version;
    expect((await b.ui('/ui/api/machines', { name: 'desk', version: v2 }, { token: t2 })).status).toBe(409);
    expect((await b.ui('/ui/api/machines', { name: 'here', session: 'default', version: v2 }, { token: t2 })).status).toBe(400);
    expect((await b.ui('/ui/api/machines', { name: 'here', session: '../x', version: v2 }, { token: t2 })).status).toBe(400);
    expect(sessions).toEqual([]);
    expect(read(a)).toEqual(before);
  });

  it('the herdr session cannot be started: 409 with the reason, nothing written', async () => {
    const { a, token } = await start(NONE);
    const before = read(a);
    sessionFails = true;
    const r = await a.ui<Reply>('/ui/api/machines', { name: 'archbox', session: 'jobs', version: (await config(a)).version }, { token });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/herdr session jobs.*herdr not found/);
    expect(read(a)).toEqual(before);
  });
});

