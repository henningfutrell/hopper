// The call log (issue #1264, a tenant migration): the calls each job source's sync passes made, one row per source and
// minute, kept a day. Sources shows each source's calls in the last hour and day from it. Derived data: the build before
// never reads it, and a lost row only lowers a count.
import type { SourceCallLog } from '../domain/sources.ts';
import type { StoreContext } from './context.ts';

export const SOURCE_CALLS_TABLE = `
  CREATE TABLE source_calls (
    source TEXT NOT NULL,
    minute TEXT NOT NULL,
    calls INTEGER NOT NULL,
    PRIMARY KEY (source, minute)
  )`;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The minute of an ISO time, as the row keys it: `2026-10-15T12:00`. Text sorts as time. */
const minuteOf = (ms: number): string => new Date(ms).toISOString().slice(0, 16);

export function createSourceCallLog(c: StoreContext): SourceCallLog {
  const since = (source: string, from: number): number =>
    Number(c.db.get('SELECT COALESCE(SUM(calls), 0) AS n FROM source_calls WHERE source = ? AND minute > ?', source, minuteOf(from))?.n ?? 0);
  return {
    record(source, at, calls) {
      const t = Date.parse(at);
      c.tx(() => {
        c.db.run(`INSERT INTO source_calls (source, minute, calls) VALUES (?, ?, ?)
          ON CONFLICT (source, minute) DO UPDATE SET calls = source_calls.calls + excluded.calls`, source, minuteOf(t), calls);
        c.db.run('DELETE FROM source_calls WHERE minute <= ?', minuteOf(t - DAY));
      });
    },
    volume(source, now) {
      const t = Date.parse(now);
      return { lastHour: since(source, t - HOUR), lastDay: since(source, t - DAY) };
    },
  };
}
