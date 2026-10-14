// Tenant migration 17 (issue #442): a claude-cli escalation level or claude-plan usage source that names
// no machine names the one machine that can run claude for it, where exactly one can. Anywhere else it is
// left as it is: Settings flags it, and a question picks a machine for it as it is asked.
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/store/db.ts';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

function at16(plugins?: unknown): Db {
  const raw = t.tenantAt(t.url(), 16);
  if (plugins !== undefined) raw.run("INSERT INTO config (name, value, updated_at) VALUES ('plugins', ?, 'x')", JSON.stringify(plugins));
  return raw;
}

const plugins = (raw: Db) => JSON.parse(String(raw.get("SELECT value FROM config WHERE name = 'plugins'")!.value)) as Record<string, unknown>;

const LEVELS = [
  { name: 'level-1', plugin: 'claude-cli', options: { bin: 'claude', model: 'opus' } },
  { name: 'level-2', plugin: 'claude-cli', options: { bin: 'claude', model: 'fable' } },
];

describe('tenant migration 17: the one machine that can run claude is named', () => {
  it('exactly one candidate: every claude-cli level and the claude-plan source name it', () => {
    const raw = at16({
      version: 1,
      machines: [{ name: 'desk', plugin: 'ssh', options: { ssh: 'desk' } }],
      escalationLevels: LEVELS,
      usageSources: [{ name: 'claude', plugin: 'claude-plan', options: { bin: 'claude', intervalSeconds: 600 } }],
    });
    migrateTenant(raw, 17);
    const doc = plugins(raw) as { escalationLevels: { options: Record<string, unknown> }[]; usageSources: { options: Record<string, unknown> }[] };
    expect(doc.escalationLevels.map((l) => l.options.machine)).toEqual(['desk', 'desk']);
    expect(doc.usageSources[0]!.options).toEqual({ bin: 'claude', intervalSeconds: 600, machine: 'desk' });
    raw.close();
  });

  it('no candidate, or several: left as it is, for Settings to flag', () => {
    for (const machines of [[], [{ name: 'box', plugin: 'docker', options: { docker: 'box' } }], [{ name: 'here', plugin: 'local' }, { name: 'desk', plugin: 'ssh', options: { ssh: 'desk' } }]]) {
      const doc = { version: 1, machines, escalationLevels: LEVELS };
      const raw = at16(doc);
      migrateTenant(raw, 17);
      expect(plugins(raw)).toEqual(doc);
      raw.close();
    }
  });

  it('no plugins config: nothing written', () => {
    const raw = at16();
    migrateTenant(raw, 17);
    expect(raw.get("SELECT value FROM config WHERE name = 'plugins'")).toBeUndefined();
    raw.close();
  });
});
