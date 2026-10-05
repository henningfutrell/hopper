// Migration 11 (issue #56): the hopper keeps no secret. A webhook subscription row names the variable
// its secret is in (`secret_env`); the `secret` column — sealed secrets, since migration 10 — is
// dropped. The rows named no variable until the webhooks document filled them (migration 14 does it).
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

describe('migration 11 (no secret in the store)', () => {
  it('drops the secret column and its values; rows stay, naming no variable until the next load', () => {
    const url = t.url();
    t.open(url).close();
    const raw = openDb(url);
    // The table as migration 10 left it.
    raw.exec('ALTER TABLE webhooks DROP COLUMN secret_env');
    raw.exec("ALTER TABLE webhooks ADD COLUMN secret TEXT NOT NULL DEFAULT ''");
    raw.run("INSERT INTO webhooks (id, name, url, events, secret, active, created_at) VALUES ('a', 'hook', 'http://127.0.0.1:1/a', '[]', 'sealed:v1:abc', 1, 'x')");
    raw.run('UPDATE schema_version SET version = 10');
    raw.close();
    t.open(url).close();
    const after = openDb(url);
    expect(after.all('SELECT * FROM webhooks')).toEqual([expect.objectContaining({ name: 'hook', secret_env: '' })]);
    expect(after.all('SELECT * FROM webhooks')[0]).not.toHaveProperty('secret');
    after.close();
  });
});
