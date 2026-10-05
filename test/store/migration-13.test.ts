// Migration 12 (issue #76): the router is a role, Jev is a model. The router plugin `jev-router` is
// `gate-router`; its options say which model answers a gate (`jevGates`, `claudeModel`) and where
// grok-bot-jev is (`grokBotJevSrc`). A stored plugins.yaml naming the old plugin is rewritten, its
// comments and every other section kept; an instance named `jev` or `jev-router` takes the plugin's
// new name.
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

function migrateFrom12(text: string | undefined): string | undefined {
  const url = t.url();
  t.open(url).close();
  const raw = openDb(url);
  if (text !== undefined) raw.run("INSERT INTO config_documents (name, text, updated_at) VALUES ('plugins.yaml', ?, 'x')", text);
  raw.run('UPDATE schema_version SET version = 12');
  raw.close();
  t.open(url).close();
  const after = openDb(url);
  const row = after.get("SELECT text FROM config_documents WHERE name = 'plugins.yaml'");
  after.close();
  return row ? String(row.text) : undefined;
}

describe('migration 13 (router plugin jev-router is gate-router)', () => {
  it('renames the plugin, the instance named jev and the options; keeps comments and other sections', () => {
    const before = [
      '# my plugins',
      'version: 1',
      'router: { name: jev, plugin: jev-router, options: { jevSrc: /j/grok-bot-jev, python: python3, model: haiku, typesafeGates: [intent] } }',
      'machines: { name: local, plugin: local, options: { lanes: 2 } }',
      '',
    ].join('\n');
    const after = migrateFrom12(before)!;
    expect(after).toContain('# my plugins');
    expect(parse(after)).toEqual({
      version: 1,
      router: { name: 'gate-router', plugin: 'gate-router', options: { grokBotJevSrc: '/j/grok-bot-jev', python: 'python3', claudeModel: 'haiku', jevGates: ['intent'] } },
      // Migration 15 runs after: machines: becomes a list (issue #74).
      machines: [{ name: 'local', plugin: 'local', options: { lanes: 2 } }],
    });
  });

  it('keeps an instance name the owner chose', () => {
    const after = migrateFrom12('version: 1\nrouter: { name: triage, plugin: jev-router, options: { jevSrc: /j } }\n')!;
    expect(parse(after).router).toEqual({ name: 'triage', plugin: 'gate-router', options: { grokBotJevSrc: '/j' } });
  });

  it('leaves another router, and a store without plugins.yaml, as they are', () => {
    const text = 'version: 1\nrouter: { name: jev, plugin: pass-through }\n';
    expect(migrateFrom12(text)).toBe(text);
    expect(migrateFrom12(undefined)).toBeUndefined();
  });

  it('leaves a plugins.yaml that does not parse as it is', () => {
    const text = 'version: 1\nrouter: [\n';
    expect(migrateFrom12(text)).toBe(text);
  });
});
