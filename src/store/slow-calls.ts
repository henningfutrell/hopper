// The store calls (issue #1154): every store call blocks the event loop for as long as it takes (db.ts), so the store's
// part of a stall is the time of the calls that ran in it. Every call is totalled by its statement's verb and first table
// only (`statementOf`): never a literal, a parameter or a schema name. The event loop watchdog (src/http/event-loop.ts)
// reads the totals at each of its ticks and names the difference across a stall (issue #1383: before, only the calls of
// 100 ms or more were kept, so a stall of many fast calls said "no slow store call in it"). A test can say how many calls
// a piece of work sends.

/** The time and the count of the calls of one statement. */
export interface StoreTotal { ms: number; count: number }

export interface SlowCalls {
  record(from: number, to: number, what: string): void;
  /** The totals by statement now: a copy, which later calls do not change. */
  totals(): Map<string, StoreTotal>;
  /** How many calls of this statement (`statementOf`) were recorded. */
  count(what: string): number;
}

export function createSlowCalls(): SlowCalls {
  // Each total is replaced, never changed, so a shallow copy is a snapshot.
  const totals = new Map<string, StoreTotal>();
  return {
    record(from, to, what) {
      const t = totals.get(what);
      totals.set(what, { ms: (t?.ms ?? 0) + (to - from), count: (t?.count ?? 0) + 1 });
    },
    totals: () => new Map(totals),
    count: (what) => totals.get(what)?.count ?? 0,
  };
}

/** A statement's verb and the first table it names: `SELECT jobs`, `INSERT checkpoints`; the verb alone when it names none. */
export function statementOf(sql: string): string {
  const s = sql.trim();
  const verb = /^[A-Za-z]+/.exec(s)?.[0]?.toUpperCase() ?? '?';
  if (verb === 'SET') return verb;
  const table = /\b(?:FROM|INTO|UPDATE|TABLE)\s+"?([A-Za-z_][\w]*)"?/i.exec(s)?.[1];
  return table ? `${verb} ${table}` : verb;
}

/** The process's store calls: every Db of this process records into it (db.ts). */
export const slowStoreCalls = createSlowCalls();
