import type { Clock, IdGen } from '../domain/ports.ts';
import type { Db } from './db.ts';

/** What every repository shares: one connection, the clock, the id source. */
export interface StoreContext {
  db: Db;
  clock: Clock;
  idGen: IdGen;
  /** Run fn in one transaction; nested calls join the outer one. */
  tx<T>(fn: () => T): T;
}

/** Shallow merge where a key present with value `undefined` clears the field. */
export function applyPatch<T extends object>(current: T, patch: object): T {
  const next: Record<string, unknown> = { ...(current as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  return next as T;
}

export const parse = <T>(body: unknown): T => JSON.parse(body as string) as T;
