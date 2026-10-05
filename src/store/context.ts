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

/**
 * The context over one connection. `onCommit` / `onRollback` run after the outermost transaction
 * ends (the event log flushes or discards what it held back).
 */
export function createContext(o: { db: Db; clock: Clock; idGen: IdGen; onCommit?: () => void; onRollback?: () => void }): StoreContext & { inTx(): boolean } {
  let depth = 0;
  return {
    db: o.db,
    clock: o.clock,
    idGen: o.idGen,
    inTx: () => depth > 0,
    tx<T>(fn: () => T): T {
      if (depth > 0) {
        depth++;
        try { return fn(); } finally { depth--; }
      }
      o.db.exec('BEGIN');
      depth = 1;
      let result: T;
      try {
        result = fn();
        o.db.exec('COMMIT');
      } catch (e) {
        depth = 0;
        o.onRollback?.();
        o.db.exec('ROLLBACK');
        throw e;
      }
      depth = 0;
      o.onCommit?.();
      return result;
    },
  };
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
