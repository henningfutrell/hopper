// A machine's resources (issue #560, design.md "Machine resources over time"): this machine's from its meter
// (src/client/resources.ts) at every list; an ssh target's from what RESOURCES_COMMAND prints in its probe —
// two /proc/stat cpu lines a second apart, the load averages, the memory lines, the memory pressure and the core count, each line
// marked `hopper-res `; a client target's from its `/release` answer, checked before it is believed. An ssh target's probe
// also prints each cgroup on its own path with a memory limit, and its user manager's (issue #2499): a seat's container
// or a slice's MemoryMax; the tightest is its memory, as this machine's meter reads it. It prints `um` when its user manager
// runs (issue #2622): each job's scope there then holds the job's memory. It prints its uptime and each page allocation
// failure dmesg holds (issue #2622 part 6, `af <seconds since boot> <order>`): the large ones of the last 10 minutes count.
// Where its user manager does not run, it prints its processes (issue #2737, JOB_PROCESSES_COMMAND), so each job's memory
// comes from them, as this machine's meter reads it (src/client/job-processes.ts). On macOS (no /proc) it prints its
// memory, load and cores from sysctl and vm_stat in the same lines, and its processes from ps.
import { nodeFloorOf } from '../client/node-floor.ts';
import { allocFailuresIn, ALLOC_FAILURE_MIN_ORDER, uptimeOf } from '../client/kernel-log.ts';
import { jobProbeMemory } from '../client/job-processes.ts';
import { pressureOf, type OomCount } from '../client/resources.ts';
import { WINDOWS_LINK_URL, type JobMemoryLimit, type JobUseNow, type ResourceReading, type WindowsLink } from '../domain/machine-history.ts';

const JOB_MEMORY_LIMITS: readonly JobMemoryLimit[] = ['scope', 'machine', 'none'];

const MARK = 'hopper-res ';

/**
 * Issue #2737: each process (`jp <pid> <ppid> <KiB of RssAnon and RssShmem>`) and each that has HOPPER_JOB_ID in its
 * environment (`je <pid> <job id>`). One cat and one grep for all of them: a process gone mid-read is left out.
 */
export const JOB_PROCESSES_COMMAND = `cat /proc/[0-9]*/status 2>/dev/null | awk '/^Name:/{if(i!="")print "jp",i,p,k; i="";p="";k=0} /^Pid:/{i=$2} /^PPid:/{p=$2} /^Rss(Anon|Shmem):/{k+=$2} END{if(i!="")print "jp",i,p,k}';`
  + ` grep -Haoz '^HOPPER_JOB_ID=[A-Za-z0-9_-]*' /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n' | sed -n 's|^/proc/\\([0-9]*\\)/environ:HOPPER_JOB_ID=|je \\1 |p'`;

/** macOS (issue #2737): memory available is the free, inactive and speculative pages; each process from ps, its job id from the environment ps prints. */
const DARWIN_COMMAND = `{ echo "MemTotal: $(($(sysctl -n hw.memsize)/1024)) kB";`
  + ` vm_stat | awk '/page size of/{for(i=1;i<=NF;i++)if($i=="of")s=$(i+1)} /^Pages (free|inactive|speculative):/{v=$NF; sub(/\\.$/,"",v); n+=v} END{if(s>0)printf "MemAvailable: %d kB\\n", n*s/1024}';`
  + ` sysctl -n vm.loadavg | tr -d '{}' | sed 's/^ *//';`
  + ` ps -axeww -o pid=,ppid=,rss=,command= | sed -E -e 's/^ *([0-9]+) +([0-9]+) +([0-9]+) .*[[:space:]]HOPPER_JOB_ID=([A-Za-z0-9_-]+).*/jp \\1 \\2 \\3 \\4/' -e t -e 's/^ *([0-9]+) +([0-9]+) +([0-9]+).*/jp \\1 \\2 \\3/';`
  + ` sysctl -n hw.ncpu; } 2>/dev/null | sed 's/^/${MARK}/'`;

/** What an ssh target's probe runs: nothing printed where there is no /proc and no macOS (the reading is then absent). */
export const RESOURCES_COMMAND = `if [ "$(uname 2>/dev/null)" = Darwin ]; then ${DARWIN_COMMAND}; elif [ -r /proc/stat ]; then { p=$(sed -n 's/^0:://p' /proc/self/cgroup); u=$(id -u); ds=$(while :; do echo "$p"; case $p in /|'') break;; esac; p=\${p%/*}; [ -n "$p" ] || p=/; done);`
  + ` t() { for d in $ds; do f=/sys/fs/cgroup\${d%/}; [ -r $f/cpu.max ] && read q r < $f/cpu.max && [ "$q" != max ] && echo ct$1 $d $(sed -n 's/^nr_periods //p;s/^nr_throttled //p' $f/cpu.stat); done; };`
  + ` head -n1 /proc/stat; t 0; sleep 1; head -n1 /proc/stat; t 1; cat /proc/loadavg;`
  + ` grep -E '^(MemTotal|MemFree|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo; grep -qi microsoft /proc/version && echo wsl; echo boot $(cat /proc/sys/kernel/random/boot_id); cat /proc/pressure/memory; sed -n 's/^oom_kill /oom /p' /proc/vmstat;`
  + ` echo up $(cut -d' ' -f1 /proc/uptime); dmesg | sed -nE 's/^\\[ *([0-9.]+)\\].*page allocation failure: order:([0-9]+).*/af \\1 \\2/p' | tail -n 500;`
  + ` m=$(printf '%s\\n' $ds | grep -m1 '/user@[0-9]*\\.service$') && x= || { m=/user.slice/user-$u.slice/user@$u.service; x=$m; };`
  + ` if [ -d /sys/fs/cgroup$m ]; then echo um; else ${JOB_PROCESSES_COMMAND}; fi;`
  + ` for d in $ds $x; do f=/sys/fs/cgroup\${d%/}; [ -r $f/memory.max ] || continue; echo cg $d $(cat $f/memory.max) $(cat $f/memory.current) $(sed -n 's/^inactive_file //p' $f/memory.stat); sed "s|^|cgp $d |" $f/memory.pressure; sed -n "s|^oom_kill |cgo $d |p" $f/memory.events; done;`
  + ` for f in /sys/fs/cgroup$m/*.slice/hopper-job-*.scope; do [ -r $f/memory.current ] || continue; echo cgj \${f#/sys/fs/cgroup} cur=$(cat $f/memory.current) $(sed -n 's/^inactive_file /i=/p' $f/memory.stat) $(sed 's/^/peak=/' $f/memory.peak) $(sed -n 's/^usage_usec /usec=/p' $f/cpu.stat) $(sed -n 's/^oom_kill /oom=/p' $f/memory.events); done;`
  + ` nproc 2>/dev/null || getconf _NPROCESSORS_ONLN; } 2>/dev/null | sed 's/^/${MARK}/'; fi`;

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
  const lines = linesOf(stdout);
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
  const free = mem.get('MemFree');
  const wsl = lines.some((l) => l.trim() === 'wsl');
  const limited = cgroupLimitOf(lines, total);
  const psi = pressureOf((limited ? cgroupPressure(lines, limited.dir) : undefined) ?? lines.join('\n'));
  const boot = bootOf(lines.map((l) => /^boot (\S+)\s*$/.exec(l)?.[1]).find((b) => b));
  const throttled = throttleOf(lines);
  const scopes = jobScopesOf(lines);
  const held = { jobMemoryLimit: lines.some((l) => l.trim() === 'um') ? 'scope' as const : limited ? 'machine' as const : 'none' as const, ...allocFailuresOf(lines) };
  const use = Object.fromEntries(scopes.filter((s) => Object.keys(s.use).length).map((s) => [s.id, s.use]));
  // Issue #2737: with no user manager, no scope holds a job: its processes say its memory.
  const procs = scopes.length || held.jobMemoryLimit === 'scope' ? new Map<string, number>() : jobProbeMemory(lines);
  const jobs = scopes.length ? { jobMemoryBytes: Object.fromEntries(scopes.map((s) => [s.id, s.bytes])), ...(Object.keys(use).length ? { jobUse: use } : {}) }
    : procs.size ? { jobMemoryBytes: Object.fromEntries(procs) } : {};
  const cpu = {
    cores,
    ...(busy !== undefined ? { cpuBusyFrac: busy } : {}),
    ...(throttled !== undefined ? { cpuThrottledFrac: throttled } : {}),
    ...(load ? { load: [Number(load[1]), Number(load[2]), Number(load[3])] as [number, number, number] } : {}),
  };
  if (limited) {
    // A scope outside the limited cgroup is not in its use, but takes the same machine's memory, as this machine's meter counts it.
    const outside = scopes.filter((s) => limited.dir !== '/' && s.dir !== limited.dir && !s.dir.startsWith(`${limited.dir}/`)).reduce((n, s) => n + s.bytes, 0);
    return {
      ...cpu, memTotalBytes: limited.total, memAvailableBytes: Math.max(0, limited.available - outside), container: true,
      kernelMemTotalBytes: total, kernelMemAvailableBytes: available, ...jobs, ...boot, ...(psi ? { memPressure: psi } : {}), ...held,
    };
  }
  return {
    ...cpu,
    memTotalBytes: total, memAvailableBytes: available,
    ...(swapTotal !== undefined && swapFree !== undefined ? { swapTotalBytes: swapTotal, swapUsedBytes: Math.max(0, swapTotal - swapFree) } : {}),
    ...(wsl ? { wsl: true as const, ...(free !== undefined ? { vmHeldBytes: Math.max(0, total - free) } : {}) } : {}),
    ...jobs, ...boot,
    ...(psi ? { memPressure: psi } : {}), ...held,
  };
}

/**
 * Issue #2499: the tightest of the cgroup memory limits an ssh target printed (`cg <dir> <max> <current> [inactive_file]`),
 * its use less the page cache it could drop; a line not whole, or a limit over the kernel's memory, is none.
 */
function cgroupLimitOf(lines: string[], kernelTotal: number): { dir: string; total: number; available: number } | undefined {
  let tightest: { dir: string; total: number; available: number } | undefined;
  for (const l of lines) {
    const m = /^cg (\/\S*) (\d+) (\d+)(?: (\d+))?\s*$/.exec(l);
    if (!m) continue;
    const total = Number(m[2]);
    if (total <= 0 || total > kernelTotal) continue;
    const available = Math.max(0, total - Math.max(0, Number(m[3]) - Number(m[4] ?? 0)));
    if (!tightest || available < tightest.available) tightest = { dir: m[1]!, total, available };
  }
  return tightest;
}

/** Issue #2622 part 6: the large page allocation failures of the last 10 minutes, by the uptime the probe printed. */
function allocFailuresOf(lines: string[]): Pick<ResourceReading, 'memAllocFailures'> {
  const up = uptimeOf(lines.find((l) => l.startsWith('up '))?.slice(3).concat(' '));
  const fails = lines.flatMap((l) => { const m = /^af (\d+(?:\.\d+)?) (\d+)\s*$/.exec(l); return m ? [{ atS: Number(m[1]), order: Number(m[2]) }] : []; });
  const recent = up !== undefined ? allocFailuresIn(fails, up) : undefined;
  return recent ? { memAllocFailures: recent } : {};
}

/** The lines RESOURCES_COMMAND printed, without their mark. */
const linesOf = (stdout: string): string[] => stdout.split('\n').filter((l) => l.startsWith(MARK)).map((l) => l.slice(MARK.length));

/**
 * Issue #2499 part 13: the OOM kill count an ssh target printed, of the cgroup whose limit it reads (`cgo <dir> <n>`), else
 * the kernel's (`oom <n>`). A count is a counter: the attached machine compares it with its probe before (`oomWatch`).
 */
export function readOomKills(stdout: string): OomCount | undefined {
  const lines = linesOf(stdout);
  const total = Number(/^MemTotal:\s+(\d+)\s*kB/m.exec(lines.join('\n'))?.[1]) * 1024;
  const limited = total > 0 ? cgroupLimitOf(lines, total) : undefined;
  const of = limited?.dir ?? 'kernel';
  const at = limited ? `cgo ${limited.dir} ` : 'oom ';
  const count = lines.map((l) => (l.startsWith(at) && /^\d+\s*$/.test(l.slice(at.length)) ? Number(l.slice(at.length)) : undefined)).find((n) => n !== undefined);
  return count !== undefined ? { of, count } : undefined;
}

/**
 * Issue #2499 part 13: of each cgroup with a CPU quota on an ssh target's path, the share of its periods throttled in the
 * probe's second (`ct0` before it, `ct1` after: `<dir> <nr_periods> <nr_throttled>`); the most of them. None with no quota.
 */
function throttleOf(lines: string[]): number | undefined {
  const at = (n: 0 | 1) => new Map(lines.flatMap((l) => {
    const m = /^ct([01]) (\/\S*) (\d+) (\d+)\s*$/.exec(l);
    return m && Number(m[1]) === n ? [[m[2]!, { periods: Number(m[3]), throttled: Number(m[4]) }] as const] : [];
  }));
  const before = at(0);
  let most: number | undefined;
  for (const [dir, { periods, throttled }] of at(1)) {
    const b = before.get(dir);
    if (b && periods > b.periods && throttled >= b.throttled) most = Math.max(most ?? 0, Math.min(1, (throttled - b.throttled) / (periods - b.periods)));
  }
  return most;
}

/**
 * Issue #2499 part 13: each job scope (`hopper-job-<id>.scope`) of an ssh target's systemd user manager, as its probe printed
 * it (`cgj <dir> cur=<n> [i=<n>] [peak=<n>] [usec=<n>] [oom=<n>]`): its memory in use less the page cache it could drop, and
 * what it used so far. No CPU cores busy: a probe reads a scope once.
 */
function jobScopesOf(lines: string[]): { id: string; dir: string; bytes: number; use: JobUseNow }[] {
  return lines.flatMap((l) => {
    const m = /^cgj (\/\S*\/hopper-job-([A-Za-z0-9_-]{1,64})\.scope)((?: [a-z]+=\d+)*)\s*$/.exec(l);
    if (!m) return [];
    const f = new Map([...m[3]!.matchAll(/ ([a-z]+)=(\d+)/g)].map((x) => [x[1]!, Number(x[2])]));
    const cur = f.get('cur');
    if (cur === undefined) return [];
    const peak = f.get('peak'), usec = f.get('usec'), oom = f.get('oom');
    const use: JobUseNow = { ...(peak !== undefined ? { memoryPeakBytes: peak } : {}), ...(usec !== undefined ? { cpuSeconds: usec / 1e6 } : {}), ...(oom !== undefined ? { oomKills: oom } : {}) };
    return [{ id: m[2]!, dir: m[1]!, bytes: Math.max(0, cur - (f.get('i') ?? 0)), use }];
  });
}

/** The memory pressure lines an ssh target printed for one cgroup (`cgp <dir> <line>`); undefined when none. */
function cgroupPressure(lines: string[], dir: string): string | undefined {
  const own = lines.filter((l) => l.startsWith(`cgp ${dir} `)).map((l) => l.slice(`cgp ${dir} `.length));
  return own.length ? own.join('\n') : undefined;
}

/** A kernel's boot id (issue #2499), when it reads as one. */
const bootOf = (v: unknown): Pick<ResourceReading, 'bootId'> => (typeof v === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(v) ? { bootId: v } : {});

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
    ...(count(r.cpuThrottledFrac) && r.cpuThrottledFrac <= 1 ? { cpuThrottledFrac: r.cpuThrottledFrac } : {}),
    ...(load ? { load: [load[0], load[1], load[2]] } : {}),
    memTotalBytes: r.memTotalBytes, memAvailableBytes: r.memAvailableBytes,
    ...(count(r.swapTotalBytes) && count(r.swapUsedBytes) ? { swapTotalBytes: r.swapTotalBytes, swapUsedBytes: r.swapUsedBytes } : {}),
    ...(r.container === true ? { container: true } : {}),
    ...(r.wsl === true ? { wsl: true } : {}),
    ...(count(r.vmHeldBytes) && r.vmHeldBytes <= r.memTotalBytes ? { vmHeldBytes: r.vmHeldBytes } : {}),
    ...(count(r.hostMemFreeBytes) && count(r.hostMemTotalBytes) && r.hostMemTotalBytes > 0 && r.hostMemFreeBytes <= r.hostMemTotalBytes
      ? { hostMemFreeBytes: r.hostMemFreeBytes, hostMemTotalBytes: r.hostMemTotalBytes } : {}),
    ...(r.wsl === true && windowsLinkOf(r.windowsLink) ? { windowsLink: windowsLinkOf(r.windowsLink)! } : {}),
    ...nodeOf(r.node),
    ...jobMemoryOf(r.jobMemoryBytes),
    ...jobUseOf(r.jobUse),
    ...bootOf(r.bootId),
    ...(count(r.kernelMemTotalBytes) && count(r.kernelMemAvailableBytes) && r.kernelMemTotalBytes > 0 && r.kernelMemAvailableBytes <= r.kernelMemTotalBytes
      ? { kernelMemTotalBytes: r.kernelMemTotalBytes, kernelMemAvailableBytes: r.kernelMemAvailableBytes } : {}),
    ...pressureOfClient(r.memPressure),
    ...(typeof r.memOomKillAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/.test(r.memOomKillAt) && Number.isFinite(Date.parse(r.memOomKillAt))
      ? { memOomKillAt: r.memOomKillAt } : {}),
    ...(JOB_MEMORY_LIMITS.includes(r.jobMemoryLimit as JobMemoryLimit) ? { jobMemoryLimit: r.jobMemoryLimit as JobMemoryLimit } : {}),
    ...allocFailuresOfClient(r.memAllocFailures),
  };
}

/** A client's large page allocation failures (issue #2622 part 6), when a count of 1 or more and an order of 4..10. */
function allocFailuresOfClient(v: unknown): Pick<ResourceReading, 'memAllocFailures'> {
  if (typeof v !== 'object' || v === null) return {};
  const { count: n, maxOrder } = v as Record<string, unknown>;
  return Number.isInteger(n) && (n as number) >= 1 && Number.isInteger(maxOrder) && (maxOrder as number) >= ALLOC_FAILURE_MIN_ORDER && (maxOrder as number) <= 10
    ? { memAllocFailures: { count: n as number, maxOrder: maxOrder as number } } : {};
}

/** A client's memory pressure (issue #2499), when both shares read as 0..100; its avg60 (issue #2622 part 5) when that does too. */
function pressureOfClient(v: unknown): Pick<ResourceReading, 'memPressure'> {
  if (typeof v !== 'object' || v === null) return {};
  const { someAvg10: some, fullAvg10: full, someAvg60: some60 } = v as Record<string, unknown>;
  return count(some) && count(full) && some <= 100 && full <= 100
    ? { memPressure: { someAvg10: some, fullAvg10: full, ...(count(some60) && some60 <= 100 ? { someAvg60: some60 } : {}) } } : {};
}

/** A client's job scope memory (issue #2499): each entry whose key reads as a job id and whose value as bytes; none, when none does. */
function jobMemoryOf(v: unknown): Pick<ResourceReading, 'jobMemoryBytes'> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
  const kept = Object.entries(v).filter(([id, bytes]) => /^[A-Za-z0-9_-]{1,64}$/.test(id) && count(bytes));
  return kept.length ? { jobMemoryBytes: Object.fromEntries(kept) as Record<string, number> } : {};
}

/** A client's job scope use (issue #2498): per job id, each field that reads as a count; a job with none is left out. */
function jobUseOf(v: unknown): Pick<ResourceReading, 'jobUse'> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
  const kept = Object.entries(v).flatMap(([id, u]): [string, JobUseNow][] => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || typeof u !== 'object' || u === null) return [];
    const x = u as Record<string, unknown>;
    const use: JobUseNow = Object.fromEntries((['memoryPeakBytes', 'cpuSeconds', 'oomKills', 'cpuCores'] as const).flatMap((k) => (count(x[k]) ? [[k, x[k]]] : [])));
    return Object.keys(use).length ? [[id, use]] : [];
  });
  return kept.length ? { jobUse: Object.fromEntries(kept) } : {};
}

/** A client's Node version (issue #2479), when it reads as one; its floor judged here, not taken from the client. */
function nodeOf(v: unknown): Pick<ResourceReading, 'node' | 'nodeFloor'> {
  if (typeof v !== 'string' || !/^v\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(v)) return {};
  const floor = nodeFloorOf(v);
  return { node: v, ...(floor ? { nodeFloor: floor } : {}) };
}

/** A client's Windows link (issue #712), when sane: a Windows link URL (`WINDOWS_LINK_URL`), `ok` and a time; a bad mode or status dropped, the reason cut short. */
function windowsLinkOf(v: unknown): WindowsLink | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const l = v as Record<string, unknown>;
  if (typeof l.url !== 'string' || !WINDOWS_LINK_URL.test(l.url) || typeof l.ok !== 'boolean') return undefined;
  if (typeof l.at !== 'string' || Number.isNaN(Date.parse(l.at))) return undefined;
  return {
    url: l.url,
    ...(typeof l.mode === 'string' && /^[a-z]{1,20}$/.test(l.mode) ? { mode: l.mode } : {}),
    ok: l.ok,
    ...(typeof l.status === 'number' && Number.isInteger(l.status) && l.status >= 100 && l.status <= 599 ? { status: l.status } : {}),
    ...(typeof l.error === 'string' && l.error ? { error: l.error.slice(0, 200) } : {}),
    at: l.at,
  };
}
