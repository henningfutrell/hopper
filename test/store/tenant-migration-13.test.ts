// Tenant migration 13 (issue #308): a client target dials in to the hopper's own URL and proves itself
// with its machine key, so the client token its runtime held (`tokenEnv`) is gone. A client target
// stored with one cannot be reached any more — its client still dials over ssh — so it leaves
// `machines`; it is added again with Add machine. Every other machine stays as it was.
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/store/db.ts';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

function at12(plugins?: unknown): Db {
  const raw = t.tenantAt(t.url(), 12);
  if (plugins !== undefined) raw.run("INSERT INTO config (name, value, updated_at) VALUES ('plugins', ?, 'x')", JSON.stringify(plugins));
  return raw;
}

const plugins = (raw: Db) => JSON.parse(String(raw.get("SELECT value FROM config WHERE name = 'plugins'")!.value)) as Record<string, unknown>;

describe('tenant migration 13: a client target holding a token variable leaves the machines', () => {
  it('drops each client instance that names tokenEnv; keeps every other machine', () => {
    const local = { name: 'local', plugin: 'local', options: { lanes: 2 } };
    const desk = { name: 'desk', plugin: 'ssh', options: { ssh: 'desk', hostKey: 'ssh-ed25519 AAAA' } };
    const joined = { name: 'box', plugin: 'client', options: { key: 'k'.repeat(43) } };
    const raw = at12({ version: 1, machines: [local, { name: 'studio', plugin: 'client', options: { tokenEnv: 'STUDIO', lanes: 1 } }, desk, joined] });
    migrateTenant(raw, 13);
    expect(plugins(raw)).toEqual({ version: 1, machines: [local, desk, joined] });
    raw.close();
  });

  it('a user with no plugins config, or no client target: nothing changes', () => {
    const none = at12();
    migrateTenant(none, 13);
    expect(none.get("SELECT value FROM config WHERE name = 'plugins'")).toBeUndefined();
    none.close();
    const raw = at12({ version: 1, machines: [{ name: 'local', plugin: 'local' }] });
    migrateTenant(raw, 13);
    expect(plugins(raw)).toEqual({ version: 1, machines: [{ name: 'local', plugin: 'local' }] });
    raw.close();
  });
});
