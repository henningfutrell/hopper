// A machine's resources (issue #560, design.md "Machine resources over time"): this machine's from its meter
// (src/client/resources.ts) at every list; an ssh target's from what RESOURCES_COMMAND prints in its probe —
// two /proc/stat cpu lines a second apart, the load averages, the memory lines and the core count, each line
// marked `hopper-res `; a client target's from its `/release` answer, checked before it is believed.
import type { ResourceReading } from '../domain/machine-history.ts';

const MARK = 'hopper-res ';

/** What an ssh target's probe runs: nothing printed where there is no /proc (the reading is then absent). */
export const RESOURCES_COMMAND = `if [ -r /proc/stat ]; then { head -n1 /proc/stat; sleep 1; head -n1 /proc/stat; cat /proc/loadavg;`
  + ` grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo; nproc 2>/dev/null || getconf _NPROCESSORS_ONLN; } 2>/dev/null | sed 's/^/${MARK}/'; fi`;

/** Busy and total jiffies of a `cpu` line: iowait counts as idle; guest time is already in user. */
function jiffies(line: string): { busy: number; total: number } | undefined {
  const v = line.trim().split(/\s+/).slice(1, 9).map(Number);
  if (v.length < 4 || v.some((n) => !Number.isFinite(n))) return undefined;
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = v;
  const busy = user + nice + system + irq + softirq + steal;
  return { busy, total: busy + idle + iowait };
}

/** The resources in what RESOURCES_COMMAND printed; undefined when it printed none. */
export function readResources(stdout: string): ResourceReading | undefined {
  const lines = stdout.split('\n').filter((l) => l.startsWith(MARK)).map((l) => l.slice(MARK.length));
  const mem = new Map(lines.flatMap((l) => { const m = /^(\w+):\s+(\d+)\s*kB/.exec(l); return m ? [[m[1]!, Number(m[2]) * 1024] as const] : []; }));
  const total = mem.get('MemTotal');
  const available = mem.get('MemAvailable');
  const cores = Number(lines.find((l) => /^\d+$/.test(l.trim())));
  if (total === undefined || available === undefined || !(cores > 0)) return undefined;
  const [a, b] = lines.filter((l) => /^cpu\s/.test(l)).map(jiffies);
  const busy = a && b && b.total > a.total ? Math.min(1, Math.max(0, (b.busy - a.busy) / (b.total - a.total))) : undefined;
  const load = lines.map((l) => /^(\d+(?:\.\d+)?) (\d+(?:\.\d+)?) (\d+(?:\.\d+)?) /.exec(l)).find((m) => m);
  const swapTotal = mem.get('SwapTotal');
  const swapFree = mem.get('SwapFree');
  return {
    cores,
    ...(busy !== undefined ? { cpuBusyFrac: busy } : {}),
    ...(load ? { load: [Number(load[1]), Number(load[2]), Number(load[3])] as [number, number, number] } : {}),
    memTotalBytes: total, memAvailableBytes: available,
    ...(swapTotal !== undefined && swapFree !== undefined ? { swapTotalBytes: swapTotal, swapUsedBytes: Math.max(0, swapTotal - swapFree) } : {}),
  };
}

const count = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** A client's answered resources, when whole and sane: cores and memory are required; a bad CPU busy, load or swap is dropped. */
export function resourcesOf(v: unknown): ResourceReading | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const r = v as Record<string, unknown>;
  if (!count(r.cores) || r.cores === 0 || !count(r.memTotalBytes) || !count(r.memAvailableBytes) || r.memAvailableBytes > r.memTotalBytes) return undefined;
  const load = Array.isArray(r.load) && r.load.length === 3 && r.load.every(count) ? r.load as [number, number, number] : undefined;
  const busy = count(r.cpuBusyFrac) && r.cpuBusyFrac <= 1 ? r.cpuBusyFrac : undefined;
  return {
    cores: r.cores,
    ...(busy !== undefined ? { cpuBusyFrac: busy } : {}),
    ...(load ? { load: [load[0], load[1], load[2]] } : {}),
    memTotalBytes: r.memTotalBytes, memAvailableBytes: r.memAvailableBytes,
    ...(count(r.swapTotalBytes) && count(r.swapUsedBytes) ? { swapTotalBytes: r.swapTotalBytes, swapUsedBytes: r.swapUsedBytes } : {}),
    ...(r.container === true ? { container: true } : {}),
  };
}
