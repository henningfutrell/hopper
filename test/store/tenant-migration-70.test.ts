// Tenant migration 70 (issue #1349): a sandbox is no machine. Every client machine of a sandbox box the hopper started
// (its `container` names a `hopper-sandbox-…` box) leaves `machines`; every other machine stays as it was.
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/store/db.ts';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

function at69(plugins?: unknown): Db {
  const raw = t.tenantAt(t.url(), 69);
  if (plugins !== undefined) raw.run("INSERT INTO config (name, value, updated_at) VALUES ('plugins', ?, 'x')", JSON.stringify(plugins));
  return raw;
}

const plugins = (raw: Db) => JSON.parse(String(raw.get("SELECT value FROM config WHERE name = 'plugins'")!.value)) as Record<string, unknown>;
const KEY = 'a'.repeat(43);
const box = (name: string) => ({ name, plugin: 'client', options: { key: KEY, template: 'asked-1', container: name, lanes: 1 } });

describe('tenant migration 70: no sandbox machines', () => {
  it('every client machine of a sandbox box leaves; the seats, a plain client and a lane pod stay', () => {
    const seat = { name: 'local', plugin: 'local', options: { lanes: 4 } };
    const client = { name: 'laptop', plugin: 'client', options: { key: KEY, lanes: 2 } };
    const pod = { name: 'hopper-job-1', plugin: 'client', options: { key: KEY, pod: 'hopper-job-1', lanes: 1 } };
    const raw = at69({ version: 1, machines: [seat, box('hopper-sandbox-claude'), client, box('hopper-sandbox-asked-302ecc9661e2-2'), pod], jobSources: [] });
    migrateTenant(raw, 70);
    expect(plugins(raw)).toEqual({ version: 1, machines: [seat, client, pod], jobSources: [] });
    raw.close();
  });

  it('a config with no sandbox machine, or no plugins config, is left as it is', () => {
    const value = { version: 1, machines: [{ name: 'local', plugin: 'local' }] };
    const raw = at69(value);
    migrateTenant(raw, 70);
    expect(plugins(raw)).toEqual(value);
    raw.close();
    const none = at69();
    migrateTenant(none, 70);
    expect(none.get("SELECT value FROM config WHERE name = 'plugins'")).toBeUndefined();
    none.close();
  });
});
