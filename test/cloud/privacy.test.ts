// hopper.io's privacy note (issue #463, docs/hopper-io-security.md R5): each field hopper.io collects, why, and for
// how long. The note is the store's columns, so a new column without its line in the note fails here, in the same
// change. A person reads it at /privacy, signed in or not.
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { PRIVACY_NOTE } from '../../cloud/privacy.ts';
import { setUp, stopAll } from './harness.ts';

afterEach(stopAll);

async function columns(databaseUrl: string): Promise<string[]> {
  const u = new URL(databaseUrl);
  const schema = u.searchParams.get('schema')!;
  u.searchParams.delete('schema');
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  try {
    const r = await c.query('SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1', [schema]);
    return r.rows.map((x) => `${x.table_name}.${x.column_name}`).sort();
  } finally { await c.end(); }
}

describe("hopper.io's privacy note", () => {
  it('lists every column of the store, each with why and for how long, and nothing else', async () => {
    const s = await setUp();
    expect(PRIVACY_NOTE.map((f) => `${f.table}.${f.column}`).sort()).toEqual(await columns(s.databaseUrl));
    for (const f of PRIVACY_NOTE) {
      expect(f.what.length, f.column).toBeGreaterThan(0);
      expect(f.why.length, f.column).toBeGreaterThan(0);
      expect(f.kept.length, f.column).toBeGreaterThan(0);
    }
  });

  it('is a page anyone can read, linked from the home page', async () => {
    const s = await setUp();
    const page = await s.server.inject({ method: 'GET', url: '/privacy' });
    expect(page.statusCode).toBe(200);
    for (const f of PRIVACY_NOTE) expect(page.body).toContain(f.why.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`));
    expect((await s.server.inject({ method: 'GET', url: '/' })).body).toContain('href="/privacy"');
  });
});
