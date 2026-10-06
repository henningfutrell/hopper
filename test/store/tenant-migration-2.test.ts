// Tenant migration 2 (issue #163): a turn that ends without a marker is a status note, and the
// hopper nudges the agent instead of asking. The herdr-claude option `idleQuestionMs` is
// `idleNudgeMs`, with its value kept; comments and everything else in the document stay.
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

/** Store `plugins` in a user schema at tenant version 1, migrate to 2, and read it back. */
function migrateFrom1(plugins: string): string {
  const raw = t.tenantAt(t.url(), 1);
  raw.run("INSERT INTO config_documents (name, text, updated_at) VALUES ('plugins.yaml', ?, 'x')", plugins);
  migrateTenant(raw, 2);
  const text = String(raw.get("SELECT text FROM config_documents WHERE name = 'plugins.yaml'")!.text);
  raw.close();
  return text;
}

describe('tenant migration 2: herdr-claude idleQuestionMs → idleNudgeMs', () => {
  it('renames the option of every herdr-claude executor, keeping its value, comments and the rest', () => {
    const after = migrateFrom1([
      '# my plugins',
      'version: 1',
      'executors:',
      '  - { name: herdr-claude, plugin: herdr-claude, options: { pollMs: 500, idleQuestionMs: 30000 } }',
      '  - { name: laptop, plugin: herdr-claude, options: { idleQuestionMs: 45000 } }',
      '  - { name: other, plugin: custom, options: { idleQuestionMs: 1 } }',
      '',
    ].join('\n'));
    expect(after).toContain('# my plugins');
    expect(parse(after)).toEqual({
      version: 1,
      executors: [
        { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 500, idleNudgeMs: 30000 } },
        { name: 'laptop', plugin: 'herdr-claude', options: { idleNudgeMs: 45000 } },
        { name: 'other', plugin: 'custom', options: { idleQuestionMs: 1 } },
      ],
    });
  });

  it('leaves a document without the option, and one that does not parse, as they are', () => {
    expect(migrateFrom1('version: 1\nexecutors: [ { name: h, plugin: herdr-claude } ]\n')).toBe('version: 1\nexecutors: [ { name: h, plugin: herdr-claude } ]\n');
    expect(migrateFrom1('version: 1\nexecutors: [ oops\n')).toBe('version: 1\nexecutors: [ oops\n');
  });
});
