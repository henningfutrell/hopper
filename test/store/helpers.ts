import type { Clock } from '../../src/domain/ports.ts';
import type { JobSpec } from '../../src/domain/types.ts';
import { openStore } from '../../src/store/index.ts';
import { testDatabaseUrl } from '../support/database.ts';

export function fixedClock(iso = '2026-10-02T10:00:00.000Z'): Clock & { set(iso: string): void } {
  let t = new Date(iso);
  return { now: () => t, set: (v: string) => { t = new Date(v); } };
}

export const spec: JobSpec = { executor: 'test', payload: { n: 1 }, goal: 'g' };

/** Temp stores: `url()` is a fresh, empty database (support/database.ts: a new Postgres schema). */
export function useTempStore() {
  return {
    url: () => testDatabaseUrl(),
    open: (url: string, clock = fixedClock()) => openStore({ url, clock }),
  };
}
