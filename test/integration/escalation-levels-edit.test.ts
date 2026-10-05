// Issue #134: the escalation levels are a live list role in order, lowest first, edited from the UI
// through POST /ui/api/plugins. Added, removed or moved, they apply to the next question without a
// restart; one edit touches the escalationLevels section of plugins.yaml and nothing else.
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import type { PluginsReport } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, writePluginsYaml, type TestApp } from '../support/app.ts';
import { readDocument } from '../support/files.ts';

/** A POST /ui/api/plugins answer: the new report, or `{ error }`. */
type Reply = PluginsReport & { error: string };

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

async function start(pluginsYaml: string): Promise<{ a: TestApp; token: string }> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  writePluginsYaml(db.dbPath, pluginsYaml);
  t = await startTestApp({ dbPath: db.dbPath });
  return { a: t, token: await t.login() };
}

const report = async (a: TestApp) => (await a.api('GET', '/api/plugins')).body;
const read = (a: TestApp) => readDocument(a.dbPath, 'plugins.yaml')!;

describe('POST /ui/api/plugins — escalation levels', () => {
  const LEVELS = `version: 1
# levels, lowest first
escalationLevels:
  - { name: opus, plugin: claude-cli, options: { model: opus } }
  - { name: fable, plugin: claude-cli, options: { model: fable } }
executors:
  - { name: test, plugin: test }
`;
  const names = (r: { body: Reply }) => r.body.escalationLevels.map((l) => l.instance.name);

  it('add appends a level on top; remove takes one out; both apply live, no restart pending', async () => {
    const { a, token } = await start(LEVELS);
    let version = (await report(a)).config.version;
    let r = await a.ui<Reply>('/ui/api/plugins', { action: 'add', role: 'escalation-level', plugin: 'claude-cli', name: 'sonnet', version }, { token });
    expect(r.status).toBe(200);
    expect(names(r)).toEqual(['opus', 'fable', 'sonnet']);
    expect(read(a)).toContain('# levels, lowest first');
    version = r.body.config.version;
    r = await a.ui<Reply>('/ui/api/plugins', { action: 'remove', role: 'escalation-level', name: 'opus', version }, { token });
    expect(r.status).toBe(200);
    expect(names(r)).toEqual(['fable', 'sonnet']);
    expect(parse(read(a)).escalationLevels.map((l: { name: string }) => l.name)).toEqual(['fable', 'sonnet']);
  });

  it('the last level removed: no levels, questions go straight to the owner', async () => {
    const { a, token } = await start('version: 1\nescalationLevels:\n  - { name: opus, plugin: claude-cli }\n');
    const version = (await report(a)).config.version;
    const r = await a.ui<Reply>('/ui/api/plugins', { action: 'remove', role: 'escalation-level', name: 'opus', version }, { token });
    expect(r.status).toBe(200);
    expect(r.body.escalationLevels).toEqual([]);
    expect(parse(read(a)).escalationLevels).toEqual([]);
  });

  it('move puts a level at a position; the others keep their order, their text and the comments', async () => {
    const { a, token } = await start(LEVELS);
    const version = (await report(a)).config.version;
    const r = await a.ui<Reply>('/ui/api/plugins', { action: 'move', role: 'escalation-level', name: 'fable', to: 0, version }, { token });
    expect(r.status).toBe(200);
    expect(names(r)).toEqual(['fable', 'opus']);
    const text = read(a);
    expect(text).toContain('# levels, lowest first');
    expect(text).toContain('  - { name: fable, plugin: claude-cli, options: { model: fable } }\n  - { name: opus, plugin: claude-cli, options: { model: opus } }\n');
  });

  it('move with no section: the built-in levels are written, in the new order', async () => {
    const { a, token } = await start('version: 1\nexecutors:\n  - { name: test, plugin: test }\n');
    const version = (await report(a)).config.version;
    const r = await a.ui<Reply>('/ui/api/plugins', { action: 'move', role: 'escalation-level', name: 'fable', to: 0, version }, { token });
    expect(r.status).toBe(200);
    expect(parse(read(a)).escalationLevels.map((l: { name: string }) => l.name)).toEqual(['fable', 'opus']);
  });

  it('move refused, nothing written: an unknown level (404), a position out of range (400), another role (400), no session (403)', async () => {
    const { a, token } = await start(LEVELS);
    const version = (await report(a)).config.version;
    const move = (body: Record<string, unknown>, session = true) => a.ui<Reply>('/ui/api/plugins', { action: 'move', role: 'escalation-level', name: 'opus', to: 1, version, ...body }, session ? { token } : {});
    expect((await move({ name: 'nope' })).status).toBe(404);
    expect((await move({ to: 2 })).status).toBe(400);
    expect((await move({ to: -1 })).status).toBe(400);
    expect((await move({ role: 'executor', name: 'test' })).status).toBe(400);
    expect((await move({}, false)).status).toBe(403);
    expect(read(a)).toBe(LEVELS);
  });
});
