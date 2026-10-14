// The stack's resources over time (issue #947, design.md "Stack resources over time"): stack samples in the instance
// schema, and the stack's resource graph read from them in SQL — per service, metric and graph step (date_bin from the
// query's origin) the peak share, and the gaps where the service gave no sample for far longer than it is usually read
// (a container stopped, OpenFGA away). The same gap rule as the machine history (store/machine-history.ts).
import { CONTAINER_GROUPS, STACK_METRICS, type ContainerGroup, type StackHistoryRepository, type StackMetric, type StackSeries, type UsageGap } from '../domain/types.ts';
import type { StoreContext } from './context.ts';

/** A stretch shorter than this is never a gap, however often the service is read. */
const MIN_GAP_MS = 5 * 60_000;
/** A stretch with no sample longer than this many of the service's usual spacing is a gap. */
const GAP_SPACINGS = 3;

const ms = (col: string) => `(extract(epoch FROM ${col})::float8 * 1000)`;
const iso = (v: unknown): string => new Date(Number(v)).toISOString();
const groupOf = (v: unknown): ContainerGroup => (CONTAINER_GROUPS as readonly unknown[]).includes(v) ? v as ContainerGroup : 'stack';

export function createStackHistoryRepository(c: StoreContext): StackHistoryRepository {
  return {
    record(samples) {
      return c.tx(() => {
        let added = 0;
        for (const s of samples) {
          added += c.db.run(
            'INSERT INTO stack_samples (at, service, metric, grp, value) VALUES (?::timestamptz, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
            s.at, s.service, s.metric, s.group, s.value).changes;
        }
        return added;
      });
    },

    series(q) {
      const range = [q.from.toISOString(), q.to.toISOString()];
      const rows = c.db.all(`
        SELECT service, metric, max(grp) AS grp, ${ms('date_bin(make_interval(secs => ?), at, to_timestamp(?))')} AS t, max(value) AS v
        FROM stack_samples WHERE at >= ?::timestamptz AND at < ?::timestamptz
        GROUP BY service, metric, t ORDER BY service, metric, t`, q.stepMs / 1000, q.originMs / 1000, ...range);
      const gapRows = c.db.all(`
        WITH s AS (SELECT service, metric, at, ${ms('(at - lag(at) OVER (PARTITION BY service, metric ORDER BY at))')} AS spacing
          FROM stack_samples WHERE at >= ?::timestamptz AND at < ?::timestamptz),
        m AS (SELECT service, metric, percentile_cont(0.5) WITHIN GROUP (ORDER BY spacing) AS usual FROM s WHERE spacing IS NOT NULL GROUP BY service, metric)
        SELECT service, metric, ${ms('s.at')} - s.spacing AS gap_from, ${ms('s.at')} AS gap_to
        FROM s JOIN m USING (service, metric) WHERE s.spacing > greatest(? * m.usual, ?) ORDER BY s.at`, ...range, GAP_SPACINGS, MIN_GAP_MS);
      const key = (r: Record<string, unknown>) => `${String(r.service)}\u0000${String(r.metric)}`;
      const gaps = new Map<string, UsageGap[]>();
      for (const r of gapRows) gaps.set(key(r), [...(gaps.get(key(r)) ?? []), { from: iso(r.gap_from), to: iso(r.gap_to) }]);
      const out = new Map<string, StackSeries>();
      for (const r of rows) {
        if (!(STACK_METRICS as readonly unknown[]).includes(r.metric)) continue;
        const k = key(r);
        let line = out.get(k);
        if (!line) {
          line = { service: String(r.service), group: groupOf(r.grp), metric: r.metric as StackMetric, points: [], gaps: gaps.get(k) ?? [] };
          out.set(k, line);
        }
        line.points.push({ at: iso(r.t), usedFrac: Math.min(1, Math.max(0, Number(r.v))) });
      }
      return [...out.values()];
    },

    prune(before) {
      return c.db.run('DELETE FROM stack_samples WHERE at < ?::timestamptz', before.toISOString()).changes;
    },
  };
}
