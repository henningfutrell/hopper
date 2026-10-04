// Migration 10 (issue #53): a webhook subscription's secret is never stored in clear. The table is a
// projection of webhooks.yaml, re-written (sealed) at every load, so a clear secret left from before
// is blanked rather than kept; a sealed one stays.
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

describe('migration 10 (no secret in clear)', () => {
  it('blanks a clear subscription secret and keeps a sealed one', () => {
    const url = t.url();
    t.open(url).close();
    const raw = openDb(url);
    raw.run("INSERT INTO webhooks (id, name, url, events, secret, active, created_at) VALUES ('a', 'clear', 'http://127.0.0.1:1/a', '[]', 's-clear', 1, 'x')");
    raw.run("INSERT INTO webhooks (id, name, url, events, secret, active, created_at) VALUES ('b', 'sealed', 'http://127.0.0.1:1/b', '[]', 'sealed:v1:abc', 1, 'x')");
    raw.run('UPDATE schema_version SET version = 9');
    raw.close();
    t.open(url).close();
    const after = openDb(url);
    expect(after.all('SELECT name, secret FROM webhooks ORDER BY name')).toEqual([{ name: 'clear', secret: '' }, { name: 'sealed', secret: 'sealed:v1:abc' }]);
    after.close();
  });
});
