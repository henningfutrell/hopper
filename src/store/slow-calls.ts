// The slow store calls (issue #1154): every store call blocks the event loop for as long as it takes (db.ts), so a
// slow one is a stall, or part of one. The calls that took at least SLOW_CALL_MS are kept, the latest SLOW_KEPT, each
// named by its statement's verb and first table only (`statementOf`): never a literal, a parameter or a schema name.
// The event loop watchdog (src/http/event-loop.ts) reads the ones that ended during a stall, to say what held it.

/** A store call this long is kept. */
export const SLOW_CALL_MS = 100;
const SLOW_KEPT = 200;

/** A slow store call: when it started and ended (`performance.now()`), and its statement. */
export interface SlowCall { from: number; to: number; what: string }

export interface SlowCalls {
  record(from: number, to: number, what: string): void;
  /** The kept calls that ended at or after `from`, oldest first. */
  since(from: number): SlowCall[];
}

export function createSlowCalls(o: { slowMs?: number; kept?: number } = {}): SlowCalls {
  const slowMs = o.slowMs ?? SLOW_CALL_MS, kept = o.kept ?? SLOW_KEPT;
  const calls: SlowCall[] = [];
  return {
    record(from, to, what) {
      if (to - from < slowMs) return;
      calls.push({ from, to, what });
      if (calls.length > kept) calls.shift();
    },
    since: (from) => calls.filter((c) => c.to >= from),
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

/** The process's slow store calls: every Db of this process records into it (db.ts). */
export const slowStoreCalls = createSlowCalls();
