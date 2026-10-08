// Tenant migration 19 (issue #451): a webhook subscription keeps its signing secret in the database, sealed
// (`secret_sealed`, with when it last changed). A subscription from before keeps the runtime variable it
// names (`secret_env`) and reads it until a secret is stored for it. Only columns are added: the build
// before still runs on the store.
import { describe, expect, it } from 'vitest';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

describe('tenant migration 19: a subscription\'s sealed secret', () => {
  it('adds the columns empty; a subscription from before keeps its variable', () => {
    const raw = t.tenantAt(t.url(), 18);
    raw.run("INSERT INTO webhooks (id, name, url, events, secret_env, active, created_at) VALUES ('w1', 'hook', 'http://127.0.0.1:1/', '[\"*\"]', 'WEBHOOK_SECRET_A', 1, '2026-10-01T00:00:00.000Z')");
    migrateTenant(raw, 19);
    expect(raw.all('SELECT id, secret_env, secret_sealed, secret_changed_at FROM webhooks')).toEqual([
      { id: 'w1', secret_env: 'WEBHOOK_SECRET_A', secret_sealed: null, secret_changed_at: null },
    ]);
    raw.close();
  });

  it('the build before adds a subscription on the migrated store as it did', () => {
    const raw = t.tenantAt(t.url(), 18);
    migrateTenant(raw, 19);
    raw.run("INSERT INTO webhooks (id, name, url, events, secret_env, active, created_at) VALUES ('w2', 'old', 'http://127.0.0.1:1/', '[\"*\"]', 'WEBHOOK_SECRET_B', 1, '2026-10-01T00:00:00.000Z')");
    expect(raw.get("SELECT secret_env, secret_sealed FROM webhooks WHERE id = 'w2'")).toEqual({ secret_env: 'WEBHOOK_SECRET_B', secret_sealed: null });
    raw.close();
  });
});
