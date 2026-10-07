// Issue #205: a machine's name and every detail are editable after it is added. A new name is the
// options edit's `rename` (POST /ui/api/plugins): one write, the instance renamed, and every machine
// option and routing rule naming it follows. Real HTTP server, the plugins config in the database.
import { afterEach, describe, expect, it } from 'vitest';
import type { MachinesConfig, PluginsReport } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, writePlugins, type TestApp } from '../support/app.ts';
import { readConfig } from '../support/files.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

const FILE = { version: 1, executors: [{ name: 'test', plugin: 'test' }], jobSources: [], machines: [{ name: 'local', plugin: 'local' }, { name: 'desk', plugin: 'ssh', options: { ssh: 'desk', lanes: 1, executors: ['test'] } }] };

async function start(file: object = FILE): Promise<{ a: TestApp; token: string }> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  writePlugins(db.dbPath, file);
  t = await startTestApp({ dbPath: db.dbPath, seams: { machineProbe: async () => ({ online: true }) } });
  return { a: t, token: await t.login() };
}

const config = async (a: TestApp): Promise<MachinesConfig> => (await a.api('GET', '/api/machines/config')).body;
const machineIds = async (a: TestApp): Promise<string[]> => (await a.api('GET', '/api/machines')).body.machines.map((m: { id: string }) => m.id);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON
const read = (a: TestApp) => readConfig(a.dbPath, 'plugins') as any;
const plugins = (a: TestApp, token: string, edit: Record<string, unknown>) => a.ui<PluginsReport & { error: string }>('/ui/api/plugins', edit, { token });

describe('POST /ui/api/plugins — rename a machine', () => {
  const NAMED = {
    ...FILE,
    escalationLevels: [{ name: 'level-1', plugin: 'claude-cli', options: { machine: 'desk' } }],
    routing: [{ name: 'to-desk', match: { label: 'desk' }, set: { machine: 'desk' } }, { name: 'other', match: { label: 'x' }, set: { priority: 70 } }],
  };
  const desk = { ssh: 'desk', lanes: 1, executors: ['test'] };

  it('renames the instance with its options in the same write; machine options and routing rules naming it follow; /api/machines lists the new id', async () => {
    const { a, token } = await start(NAMED);
    const r = await plugins(a, token, {
      action: 'options', role: 'machine-source', name: 'desk', rename: 'study', version: (await config(a)).version,
      options: { ...desk, session: 'work', label: 'the study' },
    });
    expect(r.status).toBe(200);
    const doc = read(a);
    expect(doc.machines).toEqual([FILE.machines[0], { name: 'study', plugin: 'ssh', options: { ...desk, session: 'work', label: 'the study' } }]);
    expect(doc.escalationLevels).toEqual([{ name: 'level-1', plugin: 'claude-cli', options: { machine: 'study' } }]);
    expect(doc.routing).toEqual([{ name: 'to-desk', match: { label: 'desk' }, set: { machine: 'study' } }, NAMED.routing[1]]);
    await waitFor(async () => (await machineIds(a)).includes('study'));
    expect(await machineIds(a)).toEqual(['local', 'study']);
  });

  it('the built-in local machine can be renamed too', async () => {
    const { a, token } = await start();
    const r = await plugins(a, token, { action: 'options', role: 'machine-source', name: 'local', rename: 'laptop', options: { lanes: 2 }, version: (await config(a)).version });
    expect(r.status).toBe(200);
    expect(read(a).machines[0]).toEqual({ name: 'laptop', plugin: 'local', options: { lanes: 2 } });
  });

  it('refused, nothing written: a name another machine has (409), a role other than machine-source (400), an empty name (400)', async () => {
    const { a, token } = await start(NAMED);
    const before = read(a);
    const version = (await config(a)).version;
    const taken = await plugins(a, token, { action: 'options', role: 'machine-source', name: 'desk', rename: 'local', options: desk, version });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toMatch(/local/);
    const level = await plugins(a, token, { action: 'options', role: 'escalation-level', name: 'level-1', rename: 'top', options: { machine: 'desk' }, version });
    expect(level.status).toBe(400);
    expect((await plugins(a, token, { action: 'options', role: 'machine-source', name: 'desk', rename: ' ', options: desk, version })).status).toBe(400);
    expect(read(a)).toEqual(before);
  });

  it('refused (409, naming the jobs) while a job runs there, waits for an answer in a pane there, or waits pinned to it', async () => {
    const { a, token } = await start();
    const before = read(a);
    const store = a.user().store;
    const rename = async () => plugins(a, token, { action: 'options', role: 'machine-source', name: 'desk', rename: 'study', options: desk, version: (await config(a)).version });

    // An executor no machine runs: the job stays waiting, pinned, instead of running and ending first.
    const pinned = store.jobs.create({ executor: 'nowhere', payload: {}, machineId: 'desk' }, 50);
    const held = await rename();
    expect(held.status).toBe(409);
    expect(held.body.error).toContain(pinned.id);
    store.jobs.update(pinned.id, { status: 'cancelled' });

    const parked = store.jobs.create({ executor: 'test', payload: {} }, 50);
    store.jobs.update(parked.id, { status: 'waiting_answer', resumeOn: 'desk' });
    const waiting = await rename();
    expect(waiting.status).toBe(409);
    expect(waiting.body.error).toContain(parked.id);
    expect(read(a)).toEqual(before);
  });

  it('the same name is no rename: an options edit as before', async () => {
    const { a, token } = await start();
    const r = await plugins(a, token, { action: 'options', role: 'machine-source', name: 'desk', rename: 'desk', options: { ...desk, lanes: 2 }, version: (await config(a)).version });
    expect(r.status).toBe(200);
    expect(read(a).machines[1]).toEqual({ name: 'desk', plugin: 'ssh', options: { ...desk, lanes: 2 } });
  });
});
