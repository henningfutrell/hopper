// Issue #134: the escalation levels are a live list role in order, lowest first, edited from the UI
// through POST /ui/api/plugins. Added, removed or moved, they apply to the next question without a
// restart; one edit touches the escalationLevels section of the plugins config and nothing else.
import { afterEach, describe, expect, it } from 'vitest';
import type { PluginsReport } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, writePlugins, type TestApp } from '../support/app.ts';
import { readConfig } from '../support/files.ts';

/** A POST /ui/api/plugins answer: the new report, or `{ error }`. */
type Reply = PluginsReport & { error: string };

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

async function start(plugins: object): Promise<{ a: TestApp; token: string }> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  writePlugins(db.dbPath, plugins);
  t = await startTestApp({ dbPath: db.dbPath });
  return { a: t, token: await t.login() };
}

const report = async (a: TestApp) => (await a.api('GET', '/api/plugins')).body;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON
const read = (a: TestApp) => readConfig(a.dbPath, 'plugins') as any;

describe('POST /ui/api/plugins — escalation levels', () => {
  const LEVELS = { version: 1, escalationLevels: [{ name: 'level-1', plugin: 'claude-cli', options: { model: 'opus', machine: 'local' } }, { name: 'level-2', plugin: 'claude-cli', options: { model: 'fable', machine: 'local' } }], executors: [{ name: 'test', plugin: 'test' }] };
  const names = (r: { body: Reply }) => r.body.escalationLevels.map((l) => l.instance.name);

  it('add appends a level on top; remove takes one out; both apply live, no restart pending', async () => {
    const { a, token } = await start(LEVELS);
    let version = (await report(a)).config.version;
    let r = await a.ui<Reply>('/ui/api/plugins', { action: 'add', role: 'escalation-level', plugin: 'claude-cli', name: 'level-3', options: { machine: 'local' }, version }, { token });
    expect(r.status).toBe(200);
    expect(names(r)).toEqual(['level-1', 'level-2', 'level-3']);
    expect(read(a).executors).toEqual(LEVELS.executors);
    version = r.body.config.version;
    r = await a.ui<Reply>('/ui/api/plugins', { action: 'remove', role: 'escalation-level', name: 'level-1', version }, { token });
    expect(r.status).toBe(200);
    expect(names(r)).toEqual(['level-2', 'level-3']);
    expect(read(a).escalationLevels.map((l: { name: string }) => l.name)).toEqual(['level-2', 'level-3']);
  });

  it('the last level removed: no levels, questions go straight to the owner', async () => {
    const { a, token } = await start({ version: 1, escalationLevels: [{ name: 'level-1', plugin: 'claude-cli' }] });
    const version = (await report(a)).config.version;
    const r = await a.ui<Reply>('/ui/api/plugins', { action: 'remove', role: 'escalation-level', name: 'level-1', version }, { token });
    expect(r.status).toBe(200);
    expect(r.body.escalationLevels).toEqual([]);
    expect(read(a).escalationLevels).toEqual([]);
  });

  it('move puts a level at a position; the others keep their order and their options; other sections stay', async () => {
    const { a, token } = await start(LEVELS);
    const version = (await report(a)).config.version;
    const r = await a.ui<Reply>('/ui/api/plugins', { action: 'move', role: 'escalation-level', name: 'level-2', to: 0, version }, { token });
    expect(r.status).toBe(200);
    expect(names(r)).toEqual(['level-2', 'level-1']);
    expect(read(a)).toEqual({ ...LEVELS, escalationLevels: [LEVELS.escalationLevels[1], LEVELS.escalationLevels[0]] });
  });

  it('move with no section: the built-in levels are written, in the new order', async () => {
    const { a, token } = await start({ version: 1, executors: [{ name: 'test', plugin: 'test' }] });
    const version = (await report(a)).config.version;
    const r = await a.ui<Reply>('/ui/api/plugins', { action: 'move', role: 'escalation-level', name: 'level-2', to: 0, version }, { token });
    expect(r.status).toBe(200);
    expect(read(a).escalationLevels.map((l: { name: string }) => l.name)).toEqual(['level-2', 'level-1']);
  });

  it('move refused, nothing written: an unknown level (404), a position out of range (400), another role (400), no session (403)', async () => {
    const { a, token } = await start(LEVELS);
    const version = (await report(a)).config.version;
    const move = (body: Record<string, unknown>, session = true) => a.ui<Reply>('/ui/api/plugins', { action: 'move', role: 'escalation-level', name: 'level-1', to: 1, version, ...body }, session ? { token } : {});
    expect((await move({ name: 'nope' })).status).toBe(404);
    expect((await move({ to: 2 })).status).toBe(400);
    expect((await move({ to: -1 })).status).toBe(400);
    expect((await move({ role: 'executor', name: 'test' })).status).toBe(400);
    expect((await move({}, false)).status).toBe(403);
    expect(read(a)).toEqual(LEVELS);
  });
});

// Issue #444: the levels have one editor (Question gates); the change is the UI's alone, so a stored list
// starts unchanged: its order, names and options, a level with no machine picked included.
describe('stored escalation levels across a start', () => {
  it('custom, reordered and machine-less levels read back exactly as stored', async () => {
    const levels = [
      { name: 'careful', plugin: 'claude-cli', options: { model: 'fable', machine: 'local', timeoutMs: 60000 } },
      { name: 'level-1', plugin: 'claude-cli', options: { model: 'opus' } },
      { name: 'quick', plugin: 'claude-cli', options: { model: 'sonnet', machine: 'local' } },
    ];
    const { a } = await start({ version: 1, escalationLevels: levels, executors: [{ name: 'test', plugin: 'test' }] });
    expect(read(a).escalationLevels).toEqual(levels);
    const r = await report(a);
    expect(r.escalationLevels.map((l: { instance: unknown }) => l.instance)).toEqual(levels);
  });
});
