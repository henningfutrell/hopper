// Tenant migration 12 (issue #311): herdr is called by name on an ssh machine, from its PATH, so no
// option names its binary. Every `ssh` machine instance's `herdrBin` goes; every other option and
// instance stays.
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/store/db.ts';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

function at11(plugins?: unknown): Db {
  const raw = t.tenantAt(t.url(), 11);
  if (plugins !== undefined) raw.run("INSERT INTO config (name, value, updated_at) VALUES ('plugins', ?, 'x')", JSON.stringify(plugins));
  return raw;
}

const plugins = (raw: Db) => JSON.parse(String(raw.get("SELECT value FROM config WHERE name = 'plugins'")!.value)) as Record<string, unknown>;

describe('tenant migration 12: no herdr binary on an ssh machine', () => {
  it('drops herdrBin from every ssh machine; every other option and instance stays', () => {
    const raw = at11({
      version: 1,
      executors: [{ name: 'herdr-claude', plugin: 'herdr-claude', options: { bin: '/opt/herdr' } }],
      machines: [
        { name: 'local', plugin: 'local', options: { lanes: 4 } },
        { name: 'laptop', plugin: 'ssh', options: { ssh: 'me@laptop', lanes: 2, herdrBin: '/home/me/.local/bin/herdr', hostKey: 'ssh-ed25519 AAAA' } },
        { name: 'only-bin', plugin: 'ssh', options: { ssh: 'only', herdrBin: 'herdr' } },
        { name: 'plain', plugin: 'ssh', options: { ssh: 'plain', herdr: false } },
        { name: 'box', plugin: 'docker', options: { docker: 'box' } },
      ],
    });
    migrateTenant(raw, 12);
    expect(plugins(raw)).toEqual({
      version: 1,
      executors: [{ name: 'herdr-claude', plugin: 'herdr-claude', options: { bin: '/opt/herdr' } }],
      machines: [
        { name: 'local', plugin: 'local', options: { lanes: 4 } },
        { name: 'laptop', plugin: 'ssh', options: { ssh: 'me@laptop', lanes: 2, hostKey: 'ssh-ed25519 AAAA' } },
        { name: 'only-bin', plugin: 'ssh', options: { ssh: 'only' } },
        { name: 'plain', plugin: 'ssh', options: { ssh: 'plain', herdr: false } },
        { name: 'box', plugin: 'docker', options: { docker: 'box' } },
      ],
    });
    raw.close();
  });

  it('a user with no plugins config, or none naming machines: nothing changes', () => {
    const none = at11();
    migrateTenant(none, 12);
    expect(none.get("SELECT value FROM config WHERE name = 'plugins'")).toBeUndefined();
    none.close();
    const raw = at11({ version: 1, jobSources: [] });
    migrateTenant(raw, 12);
    expect(plugins(raw)).toEqual({ version: 1, jobSources: [] });
    raw.close();
  });
});
