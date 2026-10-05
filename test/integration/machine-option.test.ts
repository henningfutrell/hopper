// Issue #174: where a part runs on a machine — an escalation level (claude-cli), a usage source
// (claude-plan) — the machine is always set, and picked from the known machines, never typed. This
// machine is no default: it is the `local` machine in the list, like any other.
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import type { PluginsReport } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, writePluginsYaml, type TestApp } from '../support/app.ts';
import { readDocument } from '../support/files.ts';

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

const report = async (a: TestApp): Promise<PluginsReport> => (await a.api('GET', '/api/plugins')).body as PluginsReport;
const read = (a: TestApp) => parse(readDocument(a.dbPath, 'plugins.yaml')!) as Record<string, { name: string; options?: Record<string, unknown> }[]>;

const MACHINES = `version: 1
machines:
  - { name: local, plugin: local, options: { lanes: 2 } }
  - { name: box, plugin: docker, options: { docker: box } }
escalationLevels:
  - { name: opus, plugin: claude-cli, options: { model: opus, machine: local } }
usageSources: []
`;

describe('a machine option is picked from the known machines (#174)', () => {
  it('GET /api/plugins marks it a machine option, required, and lists every configured machine as its choices', async () => {
    const { a } = await start(MACHINES);
    const body = await report(a);
    for (const id of ['claude-cli', 'claude-plan']) {
      const p = body.plugins.find((x) => x.id === id)!;
      const schema = p.options as { properties: Record<string, { machine?: boolean }>; required?: string[] };
      expect(schema.properties.machine!.machine).toBe(true);
      expect(schema.required).toContain('machine');
      expect(p.choices?.machine?.map((c) => c.value)).toEqual(['local', 'box']);
    }
  });

  it('a level with a machine nobody configured, or with none, is refused; one of the list is saved', async () => {
    const { a, token } = await start(MACHINES);
    const version = (await report(a)).config.version;
    const typed = await a.ui<Reply>('/ui/api/plugins', { action: 'options', role: 'escalation-level', name: 'opus', options: { model: 'opus', machine: 'elsewhere' }, version }, { token });
    expect(typed.status).toBe(400);
    expect(typed.body.error).toMatch(/machine elsewhere is not a configured machine.*local, box/);
    const none = await a.ui<Reply>('/ui/api/plugins', { action: 'options', role: 'escalation-level', name: 'opus', options: { model: 'opus' }, version }, { token });
    expect(none.status).toBe(400);
    expect(none.body.error).toMatch(/machine/);
    const picked = await a.ui<Reply>('/ui/api/plugins', { action: 'options', role: 'escalation-level', name: 'opus', options: { model: 'opus', machine: 'box' }, version }, { token });
    expect(picked.status).toBe(200);
    expect(read(a).escalationLevels![0]!.options).toEqual({ model: 'opus', machine: 'box' });
  });

  it('adding a level or usage source needs its machine: without one it is refused, with one it is written', async () => {
    const { a, token } = await start(MACHINES);
    let version = (await report(a)).config.version;
    const bare = await a.ui<Reply>('/ui/api/plugins', { action: 'add', role: 'escalation-level', plugin: 'claude-cli', name: 'sonnet', version }, { token });
    expect(bare.status).toBe(400);
    expect(bare.body.error).toMatch(/claude-cli runs on a machine: pick one of local, box/);
    const added = await a.ui<Reply>('/ui/api/plugins', { action: 'add', role: 'escalation-level', plugin: 'claude-cli', name: 'sonnet', options: { machine: 'local' }, version }, { token });
    expect(added.status).toBe(200);
    expect(read(a).escalationLevels!.find((l) => l.name === 'sonnet')).toEqual({ name: 'sonnet', plugin: 'claude-cli', options: { machine: 'local' } });
    version = added.body.config.version;
    const source = await a.ui<Reply>('/ui/api/plugins', { action: 'add', role: 'usage-source', plugin: 'claude-plan', name: 'box-plan', options: { machine: 'nowhere' }, version }, { token });
    expect(source.status).toBe(400);
    expect(source.body.error).toMatch(/machine nowhere is not a configured machine/);
  });
});

describe('a machine a part runs on stays while it is named (#174)', () => {
  it('removing a machine an escalation level names is refused until the level names another', async () => {
    const { a, token } = await start(MACHINES.replace('machine: local', 'machine: box'));
    const version = (await report(a)).config.version;
    const r = await a.ui<Reply>('/ui/api/plugins', { action: 'remove', role: 'machine-source', name: 'box', version }, { token });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/machine box is named by escalation-level opus; change it first/);
  });
});
