// Tenant migration 7 (issue #211): there is no router mode. The router's advice is always applied,
// so a user's stored `routerMode` setting goes; every other setting stays.
import { describe, expect, it } from 'vitest';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

describe('tenant migration 7: no router mode', () => {
  it('drops the routerMode setting and keeps the queue gate', () => {
    const raw = t.tenantAt(t.url(), 6);
    raw.run("INSERT INTO settings (key, value) VALUES ('routerMode', 'shadow'), ('queueGate', '{\"mode\":\"review\",\"autoAcceptPerHour\":null}')");
    migrateTenant(raw, 7);
    expect(raw.all('SELECT key, value FROM settings ORDER BY key')).toEqual([{ key: 'queueGate', value: '{"mode":"review","autoAcceptPerHour":null}' }]);
    raw.close();
  });

  it('a user that never stored a router mode: nothing changes', () => {
    const raw = t.tenantAt(t.url(), 6);
    migrateTenant(raw, 7);
    expect(raw.all('SELECT key FROM settings')).toEqual([]);
    raw.close();
  });
});
