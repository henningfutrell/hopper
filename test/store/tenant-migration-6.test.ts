// Tenant migration 6 (issue #217): the gate router's settings are concepts, not leftovers. In the
// config record `plugins`, a `gate-router` router's options move to their new names — `grokBotJevSrc`
// is `jevPath`, `claudeModel` is `model`, `timeoutMs` is `timeoutSeconds` (value / 1000) — and the
// leftovers `claudeBin` and `jevGates` go. Any other router and every other section stay.
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/store/db.ts';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

function at5(plugins?: unknown): Db {
  const raw = t.tenantAt(t.url(), 5);
  if (plugins !== undefined) raw.run("INSERT INTO config (name, value, updated_at) VALUES ('plugins', ?, 'x')", JSON.stringify(plugins));
  return raw;
}

const plugins = (raw: Db) => JSON.parse(String(raw.get("SELECT value FROM config WHERE name = 'plugins'")!.value)) as Record<string, unknown>;

describe('tenant migration 6: the gate router\'s settings are concepts', () => {
  it('renames grokBotJevSrc, claudeModel and timeoutMs; drops claudeBin and jevGates; other sections stay', () => {
    const raw = at5({
      version: 1,
      router: {
        name: 'triage', plugin: 'gate-router',
        options: { grokBotJevSrc: '/j/grok-bot-jev', python: '/v/bin/python', claudeBin: 'claude', claudeModel: 'sonnet', jevGates: ['intent'], timeoutMs: 90000 },
      },
      escalationLevels: [{ name: 'level-1', plugin: 'claude-cli', options: { model: 'opus', timeoutMs: 1000 } }],
    });
    migrateTenant(raw, 6);
    expect(plugins(raw)).toEqual({
      version: 1,
      router: { name: 'triage', plugin: 'gate-router', options: { jevPath: '/j/grok-bot-jev', python: '/v/bin/python', model: 'sonnet', timeoutSeconds: 90 } },
      escalationLevels: [{ name: 'level-1', plugin: 'claude-cli', options: { model: 'opus', timeoutMs: 1000 } }],
    });
    raw.close();
  });

  it('only the options set are moved', () => {
    const raw = at5({ version: 1, router: { name: 'gate-router', plugin: 'gate-router', options: { grokBotJevSrc: '/j' } } });
    migrateTenant(raw, 6);
    expect(plugins(raw).router).toEqual({ name: 'gate-router', plugin: 'gate-router', options: { jevPath: '/j' } });
    raw.close();
  });

  it('another router, a gate router without options, or no plugins record: nothing changes', () => {
    const none = at5();
    migrateTenant(none, 6);
    expect(none.get("SELECT value FROM config WHERE name = 'plugins'")).toBeUndefined();
    none.close();
    for (const router of [{ name: 'p', plugin: 'pass-through', options: { claudeModel: 'x' } }, { name: 'g', plugin: 'gate-router' }]) {
      const raw = at5({ version: 1, router });
      migrateTenant(raw, 6);
      expect(plugins(raw)).toEqual({ version: 1, router });
      raw.close();
    }
  });
});
