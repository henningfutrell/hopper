// Issue #260: this machine is added from the Machines view like any other — no ssh target, a name, and
// the herdr session its jobs run in, which the hopper starts (the seam here). Parts that run on a machine
// and name none (escalation levels, usage sources) run on it. Real HTTP server, the plugins config in the
// database, the sealed HOME.
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
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
  // `self` is this machine: ssh would reach this host's loopback as the user the hopper runs as.
  mkdirSync(join(homedir(), '.ssh'), { recursive: true, mode: 0o700 });
  writeFileSync(join(homedir(), '.ssh', 'config'), `Host self\n  HostName 127.0.0.1\n  User ${userInfo().username}\nHost laptop\n  HostName 192.0.2.10\n`);
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

async function start(file: object = FILE, env: Record<string, string> = {}): Promise<{ a: TestApp; token: string }> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  writePlugins(db.dbPath, file);
  t = await startTestApp({
    dbPath: db.dbPath, env,
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
    const r = await a.ui<Reply>('/ui/api/machines', { name: 'workstation', session: 'jobs', lanes: 3, version: (await config(a)).version }, { token });
    expect(r.status).toBe(200);
    expect(resolved).toEqual([]);
    expect(sessions).toContain('jobs');
    expect(read(a).machines).toEqual([DESK, { name: 'workstation', plugin: 'local', options: { lanes: 3, session: 'jobs' } }]);
    expect(r.body.machines.find((m) => m.name === 'workstation')).toEqual({ name: 'workstation', connection: 'local', options: { lanes: 3, session: 'jobs' } });
    await waitFor(async () => (await a.api('GET', '/api/machines')).body.machines.find((m: { id: string; online: boolean }) => m.id === 'workstation' && m.online));
    const listed = (await a.api('GET', '/api/machines')).body.machines.find((m: { id: string }) => m.id === 'workstation');
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
    const r = await a.ui<Reply>('/ui/api/machines', { name: 'workstation', version: (await config(a)).version }, { token });
    expect(r.status).toBe(200);
    const doc = read(a);
    expect(doc.escalationLevels.map((l: { options: { machine?: string } }) => l.options.machine)).toEqual(['workstation', 'desk']);
    expect(doc.usageSources[0].options.machine).toBe('workstation');
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
    const r = await a.ui<Reply>('/ui/api/machines', { name: 'workstation', session: 'jobs', version: (await config(a)).version }, { token });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/herdr session jobs.*herdr not found/);
    expect(read(a)).toEqual(before);
  });
});


// Issue #275: the hopper detects an ssh target that is this machine, so adding it needs no ssh.
describe('POST /ui/api/machines — an ssh target that is this machine', () => {
  const NONE = { ...FILE, machines: [DESK] };

  it('the machines config marks the ssh targets that are this machine', async () => {
    const { a } = await start(NONE);
    const c = await config(a);
    expect(c.ssh.targets).toEqual(['self', 'laptop']);
    expect(c.ssh.here).toEqual(['self']);
    expect(c.thisMachineRefused).toBeUndefined();
  });

  it('is added as this machine: a local instance, its herdr session started, nothing reached over ssh', async () => {
    const { a, token } = await start(NONE);
    const r = await a.ui<Reply>('/ui/api/machines', { name: 'workstation', ssh: 'self', lanes: 2, executors: ['herdr-claude'], version: (await config(a)).version }, { token });
    expect(r.status).toBe(200);
    expect(resolved).toEqual([]);
    expect(sessions).toEqual(['hopper']);
    expect(read(a).machines).toEqual([DESK, { name: 'workstation', plugin: 'local', options: { lanes: 2, executors: ['herdr-claude'], session: 'hopper' } }]);
  });

  it('refused while this machine is already added, saying which it is', async () => {
    const { a, token } = await start();
    const before = read(a);
    const r = await a.ui<Reply>('/ui/api/machines', { name: 'again', ssh: 'self', version: (await config(a)).version }, { token });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/self is this machine, already added as local/);
    expect(resolved).toEqual([]);
    expect(read(a)).toEqual(before);
  });

  it('another ssh target is still attached over ssh', async () => {
    const { a, token } = await start(NONE);
    await a.ui<Reply>('/ui/api/machines', { name: 'lap', ssh: 'laptop', version: (await config(a)).version }, { token });
    expect(resolved).toEqual(['laptop']);
  });
});

// Issue #275: in the container (HOPPER_LOCAL_MACHINE=false) this machine is the container, which is not a
// machine: nothing is detected as this machine there, and adding it is refused with the way that works.
describe('POST /ui/api/machines — the hopper in a container', () => {
  const NONE = { ...FILE, machines: [DESK] };
  const CONTAINER = { HOPPER_LOCAL_MACHINE: 'false' };

  it('the machines config says why this machine cannot be added and how to attach the computer it runs on', async () => {
    const { a } = await start(NONE, CONTAINER);
    const c = await config(a);
    expect(c.thisMachineRefused).toMatch(/container/);
    expect(c.thisMachineRefused).toMatch(/Add machine → A computer/);
    expect(c.ssh.here).toEqual([]);
  });

  it('adding this machine is refused with that reason, nothing written, no session started', async () => {
    const { a, token } = await start(NONE, CONTAINER);
    const before = read(a);
    const r = await a.ui<Reply>('/ui/api/machines', { name: 'box', version: (await config(a)).version }, { token });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/container/);
    expect(sessions).toEqual([]);
    expect(read(a)).toEqual(before);
  });

  it('an ssh target that resolves to the container\'s own addresses is attached over ssh, never as this machine', async () => {
    const { a, token } = await start(NONE, CONTAINER);
    await a.ui<Reply>('/ui/api/machines', { name: 'host', ssh: 'self', version: (await config(a)).version }, { token });
    expect(resolved).toEqual(['self']);
    expect(read(a).machines.every((m: { plugin: string }) => m.plugin !== 'local')).toBe(true);
  });
});
