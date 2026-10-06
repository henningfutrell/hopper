// Tenant migration 9 (issue #267): a herdr-claude executor's yolo is its own option. An instance whose
// `args` granted every permission, or that named no args (the old default did), is yolo; one whose args
// did not is not. The arguments that granted it leave `args`; every other argument and option stays.
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/store/db.ts';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

function at8(plugins?: unknown): Db {
  const raw = t.tenantAt(t.url(), 8);
  if (plugins !== undefined) raw.run("INSERT INTO config (name, value, updated_at) VALUES ('plugins', ?, 'x')", JSON.stringify(plugins));
  return raw;
}

const plugins = (raw: Db) => JSON.parse(String(raw.get("SELECT value FROM config WHERE name = 'plugins'")!.value)) as Record<string, unknown>;

describe('tenant migration 9: yolo is the herdr-claude instance\'s choice', () => {
  it('sets yolo from what the args granted, and takes the granting arguments out of args', () => {
    const raw = at8({
      version: 1,
      executors: [
        { name: 'test', plugin: 'test' },
        { name: 'herdr-claude', plugin: 'herdr-claude', options: { session: 'hopper', args: ['--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions'] } },
        { name: 'with-mcp', plugin: 'herdr-claude', options: { args: ['--dangerously-skip-permissions', '--mcp-config', 'm.json'] } },
        { name: 'careful', plugin: 'herdr-claude', options: { args: ['--permission-mode', 'acceptEdits'] } },
        { name: 'defaults', plugin: 'herdr-claude' },
        { name: 'chosen', plugin: 'herdr-claude', options: { yolo: false, args: [] } },
      ],
    });
    migrateTenant(raw, 9);
    expect(plugins(raw)).toEqual({
      version: 1,
      executors: [
        { name: 'test', plugin: 'test' },
        { name: 'herdr-claude', plugin: 'herdr-claude', options: { session: 'hopper', yolo: true } },
        { name: 'with-mcp', plugin: 'herdr-claude', options: { yolo: true, args: ['--mcp-config', 'm.json'] } },
        { name: 'careful', plugin: 'herdr-claude', options: { yolo: false, args: ['--permission-mode', 'acceptEdits'] } },
        { name: 'defaults', plugin: 'herdr-claude' },
        { name: 'chosen', plugin: 'herdr-claude', options: { yolo: false, args: [] } },
      ],
    });
    raw.close();
  });

  it('a user with no plugins config, or none naming executors: nothing changes', () => {
    const none = at8();
    migrateTenant(none, 9);
    expect(none.get("SELECT value FROM config WHERE name = 'plugins'")).toBeUndefined();
    none.close();
    const raw = at8({ version: 1, jobSources: [] });
    migrateTenant(raw, 9);
    expect(plugins(raw)).toEqual({ version: 1, jobSources: [] });
    raw.close();
  });
});
