// The usage history (issue #385, design.md "Usage history"): usage samples in the user schema, and the
// usage graph read from them in SQL — per graph step (date_bin from the query's origin) the highest share
// of the limit used, the gaps where a line has no sample for far longer than it usually reads, and the
// resets where a usage window's resetsAt moves on.
import type { UsageHistoryQuery, UsageHistoryRepository, UsageTotalSum } from '../domain/ports.ts';
import type { UsageGap, UsageSeries } from '../domain/types.ts';
import type { Param, Row } from './db.ts';
import type { StoreContext } from './context.ts';

/** A stretch shorter than this is never a gap, however often the source reads. */
const MIN_GAP_MS = 5 * 60_000;
/** A stretch with no sample longer than this many of the line's usual spacing is a gap (a source is stale after 3 intervals). */
const GAP_SPACINGS = 3;
/** A resetsAt that moves on by less than this is the same reset, read again. */
const SAME_RESET = "interval '1 minute'";

const LINE = 'source, machine_id, usage_window';
const ms = (col: string) => `(extract(epoch FROM ${col})::float8 * 1000)`;
const iso = (v: unknown): string => new Date(Number(v)).toISOString();
const keyOf = (r: Row): string => JSON.stringify([r.source, r.machine_id, r.usage_window]);

/** The step a sample falls in: `?` the step in seconds, `?` the origin in seconds. */
const STEP_START = `${ms('date_bin(make_interval(secs => ?), at, to_timestamp(?))')}`;
const IN_RANGE = 'at >= ?::timestamptz AND at < ?::timestamptz';

/** Each line's highest share of the limit per graph step. */
const PER_STEP = `
  SELECT ${LINE}, unit, bool_or(informational) AS informational, ${STEP_START} AS t,
    coalesce(max(used / NULLIF(limit_value, 0)), 0) AS frac, max(limit_value) AS lim
  FROM usage_samples WHERE ${IN_RANGE}
  GROUP BY ${LINE}, unit, t`;

const params = (q: UsageHistoryQuery): Param[] => [q.stepMs / 1000, q.originMs / 1000, q.from.toISOString(), q.to.toISOString()];
const range = (q: UsageHistoryQuery): Param[] => [q.from.toISOString(), q.to.toISOString()];

export function createUsageHistoryRepository(c: StoreContext): UsageHistoryRepository {
  const gapsOf = (q: UsageHistoryQuery): Map<string, UsageGap[]> => {
    const rows = c.db.all(`
      WITH s AS (
        SELECT ${LINE}, at, ${ms(`(at - lag(at) OVER (PARTITION BY ${LINE} ORDER BY at))`)} AS spacing
        FROM usage_samples WHERE ${IN_RANGE}),
      m AS (SELECT ${LINE}, percentile_cont(0.5) WITHIN GROUP (ORDER BY spacing) AS usual FROM s WHERE spacing IS NOT NULL GROUP BY ${LINE})
      SELECT ${LINE}, ${ms('s.at')} - s.spacing AS gap_from, ${ms('s.at')} AS gap_to
      FROM s JOIN m USING (${LINE}) WHERE s.spacing > greatest(? * m.usual, ?) ORDER BY s.at`, ...range(q), GAP_SPACINGS, MIN_GAP_MS);
    const out = new Map<string, UsageGap[]>();
    for (const r of rows) out.set(keyOf(r), [...(out.get(keyOf(r)) ?? []), { from: iso(r.gap_from), to: iso(r.gap_to) }]);
    return out;
  };

  const resetsOf = (q: UsageHistoryQuery): Map<string, string[]> => {
    const rows = c.db.all(`
      SELECT ${LINE}, ${ms('prev')} AS t FROM (
        SELECT ${LINE}, resets_at, lag(resets_at) OVER (PARTITION BY ${LINE} ORDER BY at) AS prev FROM usage_samples WHERE ${IN_RANGE}
      ) x WHERE prev IS NOT NULL AND resets_at > prev + ${SAME_RESET} ORDER BY prev`, ...range(q));
    const out = new Map<string, string[]>();
    for (const r of rows) out.set(keyOf(r), [...(out.get(keyOf(r)) ?? []), iso(r.t)]);
    return out;
  };

  const accountsOf = (q: UsageHistoryQuery): Map<string, string> => {
    const rows = c.db.all(`
      SELECT DISTINCT ON (${LINE}) ${LINE}, account FROM usage_samples
      WHERE ${IN_RANGE} AND account IS NOT NULL ORDER BY ${LINE}, at DESC`, ...range(q));
    return new Map(rows.map((r) => [keyOf(r), String(r.account)]));
  };

  return {
    record(samples) {
      return c.tx(() => {
        let added = 0;
        for (const s of samples) {
          added += c.db.run(`
            INSERT INTO usage_samples (at, source, machine_id, usage_window, used, limit_value, unit, resets_at, informational, account)
            VALUES (?::timestamptz, ?, ?, ?, ?, ?, ?, ?::timestamptz, ?, ?) ON CONFLICT DO NOTHING`,
          s.at, s.source, s.machineId ?? '', s.window ?? '', s.used, s.limit, s.unit, s.resetsAt ?? null, s.informational ? 'true' : 'false', s.account ?? null).changes;
        }
        return added;
      });
    },

    series(q) {
      const rows = c.db.all(`${PER_STEP} ORDER BY ${LINE}, unit, t`, ...params(q));
      const gaps = gapsOf(q);
      const resets = resetsOf(q);
      const accounts = accountsOf(q);
      const out: UsageSeries[] = [];
      let last: UsageSeries | undefined;
      let lastKey = '';
      for (const r of rows) {
        const key = JSON.stringify([keyOf(r), r.unit]);
        if (!last || key !== lastKey) {
          const line = keyOf(r);
          const account = accounts.get(line);
          last = {
            source: String(r.source),
            ...(r.machine_id ? { machineId: String(r.machine_id) } : {}),
            ...(r.usage_window ? { window: String(r.usage_window) } : {}),
            informational: r.informational === true,
            unit: String(r.unit),
            ...(account !== undefined ? { account } : {}),
            points: [],
            gaps: gaps.get(line) ?? [],
            resets: resets.get(line) ?? [],
          };
          lastKey = key;
          out.push(last);
        }
        last.points.push({ at: iso(r.t), usedFrac: Number(r.frac) });
      }
      return out;
    },

    totals(q) {
      const rows = c.db.all(`
        SELECT unit, usage_window, informational, t, sum(frac * lim) AS used, sum(lim) AS lim, count(*) AS n FROM (${PER_STEP}) x
        GROUP BY unit, usage_window, informational, t ORDER BY unit, usage_window, informational, t`, ...params(q));
      const out: UsageTotalSum[] = [];
      for (const r of rows) {
        let last = out.at(-1);
        if (!last || last.unit !== r.unit || (last.window ?? '') !== r.usage_window || last.informational !== (r.informational === true)) {
          last = { unit: String(r.unit), ...(r.usage_window ? { window: String(r.usage_window) } : {}), informational: r.informational === true, points: [] };
          out.push(last);
        }
        last.points.push({ at: iso(r.t), used: Number(r.used), limit: Number(r.lim), series: Number(r.n) });
      }
      return out;
    },

    prune(before) {
      return c.db.run('DELETE FROM usage_samples WHERE at < ?::timestamptz', before.toISOString()).changes;
    },
  };
}
