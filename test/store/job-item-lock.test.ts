// The lock of an item's jobs (issue #1892): two hoppers on one database each offer an item to run again; each makes its new
// job in a transaction that reads the item's newest job first. The lock (`lockItem`) holds the item to one such transaction
// at a time, so the second reads the first's new job and makes none. Held until the transaction ends; other items are free.
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { ITEM_LOCK } from '../../src/store/jobs.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

/** Whether another connection to the admin's schema of `url` gets the lock of item `key` now. */
function freeElsewhere(url: string, key: string): boolean {
  const u = new URL(url);
  u.searchParams.set('schema', `${u.searchParams.get('schema')!}_u_admin`);
  const db = openDb(u.toString());
  try {
    const held = db.get(`SELECT pg_try_advisory_lock(${ITEM_LOCK}) AS held`, key)!.held === true;
    if (held) db.get(`SELECT pg_advisory_unlock(${ITEM_LOCK}) AS released`, key);
    return held;
  } finally { db.close(); }
}

describe('the lock of an item\'s jobs (issue #1892)', () => {
  it('held by one transaction until it ends; another item stays free', () => {
    const url = t.url();
    const store = t.open(url);
    try {
      const key = 'https://github.com/owner/repo/issues/9';
      store.tx(() => {
        store.jobs.lockItem!(key);
        expect(freeElsewhere(url, key)).toBe(false);
        expect(freeElsewhere(url, 'https://github.com/owner/repo/issues/7')).toBe(true);
      });
      expect(freeElsewhere(url, key)).toBe(true);
    } finally { store.close(); }
  });
});
