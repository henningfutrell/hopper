// Machine resources over time (issue #560, design.md "Machine resources over time"): machine samples in the user
// schema, and the resource graph read from them in SQL — per machine and graph step (date_bin from the query's
// origin) the peak share of each resource used, and the gaps where the machine gave no sample for far longer than
// it is usually read (offline). The same gap rule as the usage history (store/usage-history.ts).
import type { MachineHistoryQuery, MachineHistoryRepository } from '../domain/ports.ts';
import { MACHINE_RESOURCES, type JobRun, type JobRunEnd, type MachineResource, type ResourceCost, type ResourceSeries, type UsageGap } from '../domain/types.ts';
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
  held: 'vm_held / NULLIF(mem_total, 0)',
  host: '1 - host_mem_free / NULLIF(host_mem_total, 0)',
  swap: 'swap_used / NULLIF(swap_total, 0)',
  disk: '1 - disk_free / NULLIF(disk_total, 0)',
  lanes: 'lanes_busy::float8 / NULLIF(lanes_max, 0)',
};

/**
 * Job runs (issue #688): each claim of a job on a machine and the event after it that ended it, by event order, that ended
 * in [from, to). `?`: from (events' ISO text), to.
 */
/** The job runs' CTE; its parameters: from, the job id when `oneJob` (issue #935 part 2: one job's parts list), to. */
const runsCte = (oneJob: boolean): string => `
  ev AS (
    SELECT job_id, type, machine_id, at::timestamptz AS at, lead(type) OVER w AS end_type, lead(at::timestamptz) OVER w AS end_at
    FROM events WHERE job_id IS NOT NULL AND at >= ?${oneJob ? ' AND job_id = ?' : ''}
      AND type IN ('job.claimed', 'job.finished', 'job.failed', 'job.cancelled', 'job.requeued', 'job.parked')
    WINDOW w AS (PARTITION BY job_id ORDER BY seq)),
  runs AS (
    SELECT job_id, machine_id, at AS start_at, end_at, end_type FROM ev
    WHERE type = 'job.claimed' AND machine_id IS NOT NULL AND end_type IS NOT NULL AND end_type <> 'job.claimed' AND end_at < ?::timestamptz)`;

/**
 * Used, per sample of table `t` (`s.`, or none): CPU busy (a share), memory and disk (bytes). Memory leaves out what jobs
 * with no lane in use hold (issue #2499): it is not the lanes'.
 */
const used = (t = '') => ({ cpu: `${t}cpu_busy`, mem: `(${t}mem_total - ${t}mem_available - coalesce(${t}waiting_mem, 0))`, disk: `(${t}disk_total - ${t}disk_free)` }) as const;
/** One lane's share of a sample's use net of the baseline `b`, never below 0; null where the sample or the baseline has none. */
const lanePart = (k: 'cpu' | 'mem' | 'disk'): string => {
  const net = `${used('s.')[k]} - b.${k}`;
  return `CASE WHEN ${net} IS NULL THEN NULL ELSE greatest(0, ${net}) / greatest(s.lanes_busy, 1) END`;
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
            INSERT INTO machine_samples (at, machine_id, cores, cpu_busy, load1, mem_total, mem_available, swap_total, swap_used, disk_free, disk_total,
              vm_held, host_mem_free, host_mem_total, waiting_mem, lanes_busy, lanes_max)
            VALUES (?::timestamptz, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
          s.at, s.machineId, s.cores ?? null, s.cpuBusyFrac ?? null, s.load1 ?? null, s.memTotalBytes ?? null, s.memAvailableBytes ?? null,
          s.swapTotalBytes ?? null, s.swapUsedBytes ?? null, s.diskFreeBytes ?? null, s.diskTotalBytes ?? null,
          s.vmHeldBytes ?? null, s.hostMemFreeBytes ?? null, s.hostMemTotalBytes ?? null, s.waitingMemBytes ?? null, s.lanesBusy, s.lanesMax).changes;
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

    // Lane load (issue #688): per machine and lanes in use, how many samples, how many at or above each resource
    // pressure, and the average CPU busy and memory used.
    laneLoad(q) {
      const num = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : Number(v));
      const rows = c.db.all(`
        SELECT machine_id, lanes_busy, count(*) AS samples,
          count(*) FILTER (WHERE ${SHARE.cpu} >= ?) AS cpu_p,
          count(*) FILTER (WHERE ${SHARE.memory} >= ?) AS mem_p,
          count(*) FILTER (WHERE ${SHARE.disk} >= ?) AS disk_p,
          avg(cpu_busy) AS cpu_avg, avg(${used().mem}) AS mem_used, max(mem_total) AS mem_total
        FROM machine_samples WHERE at >= ?::timestamptz AND at < ?::timestamptz
        GROUP BY machine_id, lanes_busy ORDER BY machine_id, lanes_busy`,
      q.pressure.cpu, q.pressure.memory, q.pressure.disk, q.from.toISOString(), q.to.toISOString());
      return rows.map((r) => {
        const cpuAvg = num(r.cpu_avg), memUsedAvgBytes = num(r.mem_used), memTotalBytes = num(r.mem_total);
        return {
          machineId: String(r.machine_id), lanesBusy: Number(r.lanes_busy), samples: Number(r.samples),
          pressured: { cpu: Number(r.cpu_p), memory: Number(r.mem_p), disk: Number(r.disk_p) },
          ...(cpuAvg !== undefined ? { cpuAvg } : {}),
          ...(memUsedAvgBytes !== undefined ? { memUsedAvgBytes } : {}),
          ...(memTotalBytes !== undefined ? { memTotalBytes } : {}),
        };
      });
    },

    // Job runs (issue #688): per run, one lane's share of each resource net of its machine's baseline — the average of
    // the machine's samples with no lane in use over [from, to) —, averaged and peaked over the samples in the run; and
    // per usage window the rise of the machine's usage samples in it, as a share of the limit.
    jobRuns(q) {
      const RUNS = runsCte(q.jobId !== undefined);
      const one: Param[] = q.jobId !== undefined ? [q.jobId] : [];
      const num = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : Number(v));
      const cost = (avg: unknown, peak: unknown): ResourceCost | undefined => (num(avg) === undefined ? undefined : { avg: Number(avg), peak: Number(peak) });
      const from = q.from.toISOString(), to = q.to.toISOString();
      const rows = c.db.all(`
        WITH ${RUNS},
        b AS (
          SELECT machine_id, avg(${used().cpu}) AS cpu, avg(${used().mem}) AS mem, avg(${used().disk}) AS disk
          FROM machine_samples WHERE lanes_busy = 0 AND at >= ?::timestamptz AND at < ?::timestamptz GROUP BY machine_id),
        p AS (
          SELECT r.job_id, r.start_at, s.lanes_busy, ${lanePart('cpu')} AS cpu, ${lanePart('mem')} AS mem, ${lanePart('disk')} AS disk
          FROM runs r JOIN machine_samples s ON s.machine_id = r.machine_id AND s.at >= r.start_at AND s.at < r.end_at
          LEFT JOIN b ON b.machine_id = r.machine_id)
        SELECT r.job_id, r.machine_id, ${ms('r.start_at')} AS start_ms, ${ms('r.end_at')} AS end_ms, r.end_type,
          count(p.job_id) AS samples, avg(p.lanes_busy) AS lanes, avg(p.cpu) AS cpu_avg, max(p.cpu) AS cpu_peak,
          avg(p.mem) AS mem_avg, max(p.mem) AS mem_peak, avg(p.disk) AS disk_avg, max(p.disk) AS disk_peak
        FROM runs r LEFT JOIN p ON p.job_id = r.job_id AND p.start_at = r.start_at
        GROUP BY r.job_id, r.machine_id, r.start_at, r.end_at, r.end_type ORDER BY r.start_at`, from, ...one, to, from, to);
      const burns = c.db.all(`
        WITH ${RUNS}
        SELECT r.job_id, ${ms('r.start_at')} AS start_ms, coalesce(NULLIF(u.usage_window, ''), u.source) AS w,
          (array_agg(u.used / NULLIF(u.limit_value, 0) ORDER BY u.at DESC))[1] - (array_agg(u.used / NULLIF(u.limit_value, 0) ORDER BY u.at))[1] AS rise
        FROM runs r JOIN usage_samples u ON u.machine_id = r.machine_id AND u.at >= r.start_at AND u.at < r.end_at AND NOT u.informational
        GROUP BY r.job_id, r.start_at, u.source, u.usage_window`, from, ...one, to);
      const usage = new Map<string, Record<string, number>>();
      for (const u of burns) {
        const key = `${String(u.job_id)} ${Number(u.start_ms)}`;
        const mine = usage.get(key) ?? {};
        const rise = Math.max(0, num(u.rise) ?? 0);
        mine[String(u.w)] = Math.max(mine[String(u.w)] ?? 0, rise);
        usage.set(key, mine);
      }
      return rows.map((r): JobRun => {
        const lanes = num(r.lanes);
        const parts = { cpu: cost(r.cpu_avg, r.cpu_peak), memoryBytes: cost(r.mem_avg, r.mem_peak), diskBytes: cost(r.disk_avg, r.disk_peak) };
        return {
          jobId: String(r.job_id), machineId: String(r.machine_id), startedAt: iso(r.start_ms), endedAt: iso(r.end_ms),
          end: String(r.end_type).slice('job.'.length) as JobRunEnd, samples: Number(r.samples),
          ...(lanes !== undefined ? { lanesBusyAvg: lanes } : {}),
          ...Object.fromEntries(Object.entries(parts).filter(([, v]) => v !== undefined)),
          usage: usage.get(`${String(r.job_id)} ${Number(r.start_ms)}`) ?? {},
        };
      });
    },

    prune(before) {
      return c.db.run('DELETE FROM machine_samples WHERE at < ?::timestamptz', before.toISOString()).changes;
    },
  };
}
