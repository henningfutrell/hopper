// The secret canary check's WAL reader (issue #1957 part 5): a value a WAL record holds is found even when the record
// runs over the end of a WAL page, where Postgres puts the next page's header in the middle of it. A batch run went red
// when a removed canary sat across such a seam (issue #2236).
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { testDatabaseUrl } from '../support/database.ts';
import { canary, scan, walMark, walPlaces } from '../support/secret-canary.ts';

describe('the secret canary check reads the WAL', () => {
  it('finds every removed value, also one a WAL page header splits', (ctx) => {
    const url = testDatabaseUrl();
    const schema = new URL(url).searchParams.get('schema')!;
    const db = openDb(url);
    const wal = walMark(url);
    if (!wal) ctx.skip(); // the test's database role cannot read the WAL: an environment skip
    // About 2000 records of some 100 bytes each run over some 25 page ends: a value a page header does not split
    // in one of them is a value the reader did not need to join.
    const removed = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`removed ${i}`, canary(`r${i}`)]));
    try {
      db.exec(`CREATE SCHEMA IF NOT EXISTS ${schema}; CREATE TABLE ${schema}.leak (note text)`);
      db.run(`INSERT INTO ${schema}.leak (note) SELECT unnest(string_to_array(?, ','))`, Object.values(removed).join(','));
      db.run(`INSERT INTO ${schema}.leak (note) VALUES (?)`, randomBytes(8).toString('hex'));
      db.exec(`DELETE FROM ${schema}.leak`);
    } finally {
      db.close();
    }
    const found = new Set(scan(removed, walPlaces(url, wal!)).filter((f) => f.form === 'plain').map((f) => f.canary));
    const missed = Object.keys(removed).filter((k) => !found.has(k));
    expect(missed).toEqual([]);
  }, 60_000);
});
