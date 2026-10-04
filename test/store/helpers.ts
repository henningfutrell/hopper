import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import type { Clock } from '../../src/domain/ports.ts';
import type { JobSpec } from '../../src/domain/types.ts';
import { openStore } from '../../src/store/index.ts';
import { testDatabaseUrl } from '../support/database.ts';

export function fixedClock(iso = '2026-10-02T10:00:00.000Z'): Clock & { set(iso: string): void } {
  let t = new Date(iso);
  return { now: () => t, set: (v: string) => { t = new Date(v); } };
}

export const spec: JobSpec = { executor: 'test', payload: { n: 1 }, goal: 'g' };

/**
 * Temp stores, removed after each test. `url()` is a fresh, empty database of the backend under
 * test (support/database.ts: SQLite, or Postgres when JOB_HOPPER_TEST_POSTGRES_URL is set);
 * `path()` is a fresh SQLite file, for the SQLite migration history. `open` takes either.
 */
export function useTempStore() {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const dir = () => { const d = mkdtempSync(join(tmpdir(), 'jh-store-')); dirs.push(d); return d; };
  return {
    path: () => join(dir(), 'nested', 'jh.sqlite'),
    url: () => testDatabaseUrl(dir()),
    open: (urlOrPath: string, clock = fixedClock()) => openStore({ url: urlOrPath.includes(':') ? urlOrPath : `sqlite:${urlOrPath}`, clock }),
  };
}
