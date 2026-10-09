// Machine resources over time (issue #560, design.md "Machine resources over time"): machine samples in the user
// schema, and the resource graph read from them in SQL — per machine and graph step (date_bin from the query's
// origin) the peak share of each resource used, and the gaps where the machine gave no sample for far longer than
// it is usually read (offline). The same gap rule as the usage history (store/usage-history.ts).
import type { MachineHistoryQuery, MachineHistoryRepository } from '../domain/ports.ts';
import { MACHINE_RESOURCES, type MachineResource, type ResourceSeries, type UsageGap } from '../domain/types.ts';
import type { Param } from './db.ts';
import type { StoreContext } from './context.ts';

/** A stretch shorter than this is never a gap, however often the machine is read. */
const MIN_GAP_MS = 5 * 60_000;
/** A stretch with no sample longer than this many of the machine's usual spacing is a gap. */
const GAP_SPACINGS = 3;

const ms = (col: string) => `(extract(epoch FROM ${col})::float8 * 1000)`;
const iso = (v: unknown): string => new Date(Number(v)).toISOString();

/** Each resource as a share used, per sample: absent (null) where the sample did not read it. */
const SHARE: Readonly<Record<MachineResource, string>> = {
  cpu: 'cpu_busy',
  memory: '1 - mem_available / NULLIF(mem_total, 0)',
  swap: 'swap_used / NULLIF(swap_total, 0)',
  disk: '1 - disk_free / NULLIF(disk_total, 0)',
  lanes: 'lanes_busy::float8 / NULLIF(lanes_max, 0)',
};

export function createMachineHistoryRepository(c: StoreContext): MachineHistoryRepository {
  const where = (q: MachineHistoryQuery): { sql: string; params: Param[] } => ({
    sql: `at >= ?::timestamptz AND at < ?::timestamptz${q.machineId !== undefined ? ' AND machine_id = ?' : ''}`,
    params: [q.from.toISOString(), q.to.toISOString(), ...(q.machineId !== undefined ? [q.machineId] : [])],
  });

  const gapsOf = (q: MachineHistoryQuery): Map<string, UsageGap[]> => {
    const w = where(q);
    const rows = c.db.all(`
      WITH s AS (SELECT machine_id, at, ${ms('(at - lag(at) OVER (PARTITION BY machine_id ORDER BY at))')} AS spacing FROM machine_samples WHERE ${w.sql}),
      m AS (SELECT machine_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY spacing) AS usual FROM s WHERE spacing IS NOT NULL GROUP BY machine_id)
      SELECT machine_id, ${ms('s.at')} - s.spacing AS gap_from, ${ms('s.at')} AS gap_to
      FROM s JOIN m USING (machine_id) WHERE s.spacing > greatest(? * m.usual, ?) ORDER BY s.at`, ...w.params, GAP_SPACINGS, MIN_GAP_MS);
    const out = new Map<string, UsageGap[]>();
    for (const r of rows) {
      const id = String(r.machine_id);
      out.set(id, [...(out.get(id) ?? []), { from: iso(r.gap_from), to: iso(r.gap_to) }]);
    }
    return out;
  };

  return {
    record(samples) {
      return c.tx(() => {
        let added = 0;
        for (const s of samples) {
          added += c.db.run(`
            INSERT INTO machine_samples (at, machine_id, cores, cpu_busy, load1, mem_total, mem_available, swap_total, swap_used, disk_free, disk_total, lanes_busy, lanes_max)
            VALUES (?::timestamptz, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
          s.at, s.machineId, s.cores ?? null, s.cpuBusyFrac ?? null, s.load1 ?? null, s.memTotalBytes ?? null, s.memAvailableBytes ?? null,
          s.swapTotalBytes ?? null, s.swapUsedBytes ?? null, s.diskFreeBytes ?? null, s.diskTotalBytes ?? null, s.lanesBusy, s.lanesMax).changes;
        }
        return added;
      });
    },

    series(q) {
      const w = where(q);
      const peaks = MACHINE_RESOURCES.map((r) => `max(${SHARE[r]}) AS ${r}`).join(', ');
      const rows = c.db.all(`
        SELECT machine_id, ${ms('date_bin(make_interval(secs => ?), at, to_timestamp(?))')} AS t, ${peaks}
        FROM machine_samples WHERE ${w.sql} GROUP BY machine_id, t ORDER BY machine_id, t`, q.stepMs / 1000, q.originMs / 1000, ...w.params);
      const gaps = gapsOf(q);
      const out: ResourceSeries[] = [];
      for (const id of [...new Set(rows.map((r) => String(r.machine_id)))]) {
        const mine = rows.filter((r) => String(r.machine_id) === id);
        for (const resource of MACHINE_RESOURCES) {
          const points = mine.flatMap((r) => (r[resource] === null || r[resource] === undefined ? [] : [{ at: iso(r.t), usedFrac: Math.min(1, Math.max(0, Number(r[resource]))) }]));
          if (points.length) out.push({ machineId: id, resource, points, gaps: gaps.get(id) ?? [] });
        }
      }
      return out;
    },

    prune(before) {
      return c.db.run('DELETE FROM machine_samples WHERE at < ?::timestamptz', before.toISOString()).changes;
    },
  };
}
