// Issue #2966: the claude-plan option `noLimits` is gone; `meter` takes its place. The migration gives each usage source
// with `noLimits: true` the meter `analytics`, and takes `noLimits: false` off. Every other option and instance stays.
import { describe, expect, it } from 'vitest';
import { usageMeterOption } from '../../src/store/migration-usage-meter.ts';
import { migrateTenant, TENANT_SCHEMA_VERSION } from '../../src/store/tenant-migrations.ts';
import { RECENT_TENANT_MIGRATIONS } from '../../src/store/tenant-migrations-recent.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();
const VERSION = TENANT_SCHEMA_VERSION - RECENT_TENANT_MIGRATIONS.length + RECENT_TENANT_MIGRATIONS.indexOf(usageMeterOption) + 1;

describe('the usage meter option (issue #2966)', () => {
  it('noLimits on becomes meter analytics; noLimits off goes; other instances stay', () => {
    const db = t.tenantAt(t.url(), VERSION - 1);
    const plugins = {
      version: 1,
      executors: [{ name: 'claude', plugin: 'claude-cli', options: { noLimits: true } }],
      usageSources: [
        { name: 'a', plugin: 'claude-plan', options: { machine: 'l4', noLimits: true, dayCostUsd: 5 } },
        { name: 'b', plugin: 'claude-plan', options: { machine: 'l2', noLimits: false } },
        { name: 'c', plugin: 'claude-plan', options: { machine: 'l3' } },
        { name: 'd', plugin: 'command-usage', options: { noLimits: true } },
      ],
    };
    db.run("INSERT INTO config (name, value, updated_at) VALUES ('plugins', ?, '2026-11-01T00:00:00.000Z') ON CONFLICT (name) DO UPDATE SET value = excluded.value", JSON.stringify(plugins));

    migrateTenant(db, VERSION);

    const value = JSON.parse(String(db.get("SELECT value FROM config WHERE name = 'plugins'")!.value)) as typeof plugins;
    expect(value.usageSources).toEqual([
      { name: 'a', plugin: 'claude-plan', options: { machine: 'l4', dayCostUsd: 5, meter: 'analytics' } },
      { name: 'b', plugin: 'claude-plan', options: { machine: 'l2' } },
      { name: 'c', plugin: 'claude-plan', options: { machine: 'l3' } },
      { name: 'd', plugin: 'command-usage', options: { noLimits: true } },
    ]);
    expect(value.executors).toEqual(plugins.executors);
    db.close();
  });
});
