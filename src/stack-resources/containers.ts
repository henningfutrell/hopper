// The container meter (issue #947, design.md "Stack resources"): what each container of the hopper's own compose stack
// and each sandbox box of this hopper uses, read from the container runtime through its socket — the one sandbox boxes
// start through (HOPPER_PODMAN_SOCKET, else HOPPER_DOCKER_SOCKET). Podman and Docker both serve the Docker-compatible API,
// so one reader serves both: the list, each container's inspect and its one-shot stats, and the disk use. Read through
// the shared socket call (src/sandbox/socket-http.ts), not a client library: four GETs need none. On a client target
// (`machine`), the same reader reads the hopper's boxes there through its remote runtime (remote.ts): libpod's list,
// inspect and per-container stats answer in these shapes too.
import type { ContainerGroup, ContainerMeter, ContainerReading } from '../domain/stack-resources.ts';
import { ok, refusal, socketCall, socketName, type Answer, type RuntimeSocket, type SocketCall } from '../sandbox/socket-http.ts';

/** The labels compose (docker compose and podman-compose alike) puts on each container it starts. */
const PROJECT_LABEL = 'com.docker.compose.project';
const SERVICE_LABEL = 'com.docker.compose.service';
/** The label of a sandbox box the hopper started (src/sandbox/launch.ts): its instance id. */
const BOX_LABEL = 'io.hopper.box';
/** The project a hopper that is not in a container reads: compose.yaml's `name`. */
const DEFAULT_PROJECT = 'hopper';
/** The disk use counts every layer and volume: read at most this often, and kept between. */
const DF_EVERY_MS = 10 * 60_000;
/** How long a read waits for the disk use; it goes on in the background, up to DF_MS, for the next read. */
const DF_WAIT_MS = 2_000;
const DF_MS = 5 * 60_000;
/** One stats call may take a second or two on Podman (it samples): never longer than this. */
const STATS_MS = 10_000;

interface Listed { Id?: string; Names?: string[]; Image?: string; Labels?: Record<string, string> | null; State?: string }
interface Inspected {
  State?: { Status?: string; StartedAt?: string; Health?: { Status?: string } };
  RestartCount?: number;
  HostConfig?: { NanoCpus?: number; CpuQuota?: number; CpuPeriod?: number; Memory?: number };
  Mounts?: { Type?: string; Name?: string }[];
}
interface CpuStats { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number; online_cpus?: number }
interface Stats {
  cpu_stats?: CpuStats;
  precpu_stats?: CpuStats;
  memory_stats?: { usage?: number; limit?: number; stats?: Record<string, number> };
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
  blkio_stats?: { io_service_bytes_recursive?: { op?: string; value?: number }[] | null };
}
interface DiskUse { layers: Map<string, number>; volumes: Map<string, number> }

const count = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const sum = (vs: (number | undefined)[]): number | undefined => (vs.some(count) ? vs.reduce<number>((a, v) => a + (count(v) ? v : 0), 0) : undefined);

/** A start time the runtime gives, or none: a container that never ran says the year 1. */
function startedAt(s: string | undefined): string | undefined {
  const t = s ? Date.parse(s) : NaN;
  return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : undefined;
}

/** CPU cores a quota allows: Docker's NanoCpus, or a quota over its period. */
function cpuLimit(h: Inspected['HostConfig']): number | undefined {
  if (count(h?.NanoCpus) && h.NanoCpus > 0) return h.NanoCpus / 1e9;
  if (count(h?.CpuQuota) && h.CpuQuota > 0) return h.CpuQuota / (count(h.CpuPeriod) && h.CpuPeriod > 0 ? h.CpuPeriod : 100_000);
  return undefined;
}

/** Memory in use less the page cache it could drop: cgroup v2's `inactive_file`, v1's `total_inactive_file`. */
function memUsed(m: Stats['memory_stats']): number | undefined {
  if (!count(m?.usage)) return undefined;
  const cache = m.stats?.inactive_file ?? m.stats?.total_inactive_file;
  return Math.max(0, m.usage - (count(cache) ? cache : 0));
}

function diskBytes(s: Stats, op: 'read' | 'write'): number | undefined {
  const rows = (s.blkio_stats?.io_service_bytes_recursive ?? []).filter((r) => r.op?.toLowerCase() === op);
  return rows.length ? sum(rows.map((r) => r.value)) : undefined;
}

/** CPU cores busy by the runtime's own two readings, when it gave both (Docker's formula). */
function runtimeCpu(s: Stats): number | undefined {
  const now = s.cpu_stats;
  const before = s.precpu_stats;
  const used = (now?.cpu_usage?.total_usage ?? NaN) - (before?.cpu_usage?.total_usage ?? NaN);
  const system = (now?.system_cpu_usage ?? NaN) - (before?.system_cpu_usage ?? NaN);
  const cores = now?.online_cpus;
  if (!(used >= 0) || !(system > 0) || !count(cores) || cores === 0) return undefined;
  return (used / system) * cores;
}

export function createContainerMeter(o: {
  /** The runtime's socket, or a Podman host's stream (issue #2272). */
  socket: RuntimeSocket;
  /** This process's host name: in a container, its id's start, which finds the hopper's own container and project. */
  self: string;
  /** This hopper's instance id: the boxes it started carry it. */
  instanceId: string;
  /** The API's path prefix (the remote runtime's calls name their API version); none: the Docker-compatible API's own. */
  prefix?: string;
  /**
   * The client target read (remote.ts): only this hopper's boxes there, each labelled `<machine>/<name>`, and no disk use
   * (its client carries no such call). Absent: the computer the hopper runs on, its compose project and its boxes.
   */
  machine?: string;
  now?: () => number;
  via?: SocketCall;
}): ContainerMeter {
  const via = o.via ?? socketCall;
  const now = o.now ?? Date.now;
  const call = (path: string, timeoutMs?: number): Promise<Answer> => via(o.socket, 'GET', `${o.prefix ?? ''}${path}`, undefined, timeoutMs);
  const nameOf = (c: Listed): string => (c.Names?.[0] ?? c.Id ?? '').replace(/^\//, '');
  /** Each container's CPU time (ns) at its last read, and when: the next read's CPU is the difference. */
  const lastCpu = new Map<string, { usage: number; at: number }>();
  let df: { at: number; use: DiskUse } | undefined;

  /** One disk use read at a time, in the background: on a runtime with many images it takes minutes. */
  let dfRead: Promise<void> | undefined;
  const refreshDiskUse = (): Promise<void> => {
    dfRead ??= call('/system/df', DF_MS).then((a) => {
      if (!ok(a)) return;
      const body = JSON.parse(a.text) as { Containers?: { Id?: string; SizeRw?: number }[] | null; Volumes?: { Name?: string; UsageData?: { Size?: number } | null }[] | null };
      df = {
        at: now(),
        use: {
          layers: new Map((body.Containers ?? []).flatMap((c) => (c.Id && count(c.SizeRw) ? [[c.Id, c.SizeRw] as const] : []))),
          volumes: new Map((body.Volumes ?? []).flatMap((v) => (v.Name && count(v.UsageData?.Size) ? [[v.Name, v.UsageData.Size] as const] : []))),
        },
      };
    }, () => undefined).finally(() => { dfRead = undefined; });
    return dfRead;
  };
  /** The disk use: refreshed when it is older than DF_EVERY_MS, waited for at most DF_WAIT_MS; else the last one, or none. */
  const diskUse = async (): Promise<DiskUse | undefined> => {
    if (!df || now() - df.at >= DF_EVERY_MS) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([refreshDiskUse(), new Promise<void>((resolve) => { timer = setTimeout(resolve, DF_WAIT_MS); timer.unref(); })]);
      clearTimeout(timer);
    }
    return df?.use;
  };

  const cpuOf = (id: string, s: Stats): number | undefined => {
    const usage = s.cpu_stats?.cpu_usage?.total_usage;
    const at = now();
    const before = lastCpu.get(id);
    if (count(usage)) lastCpu.set(id, { usage, at });
    if (before && count(usage) && at > before.at && usage >= before.usage) return (usage - before.usage) / ((at - before.at) * 1e6);
    return runtimeCpu(s);
  };

  const readOne = async (c: Listed, group: ContainerGroup, service: string, disk: DiskUse | undefined): Promise<ContainerReading> => {
    const id = c.Id ?? '';
    const reading: ContainerReading = { service, group, ...(o.machine !== undefined ? { machine: o.machine } : {}), name: nameOf(c), image: c.Image ?? '', state: c.State ?? '' };
    const inspected = await call(`/containers/${encodeURIComponent(id)}/json`).then((a) => (ok(a) ? JSON.parse(a.text) as Inspected : undefined), () => undefined);
    if (inspected) {
      reading.state = inspected.State?.Status ?? reading.state;
      const health = inspected.State?.Health?.Status;
      if (health) reading.health = health;
      if (reading.state === 'running') {
        const started = startedAt(inspected.State?.StartedAt);
        if (started) reading.startedAt = started;
      }
      if (count(inspected.RestartCount)) reading.restarts = inspected.RestartCount;
      const cpus = cpuLimit(inspected.HostConfig);
      if (cpus !== undefined) reading.cpuLimitCores = cpus;
      if (count(inspected.HostConfig?.Memory) && inspected.HostConfig.Memory > 0) reading.memLimitBytes = inspected.HostConfig.Memory;
    }
    if (reading.state === 'running') {
      const stats = await call(`/containers/${encodeURIComponent(id)}/stats?stream=false`, STATS_MS)
        .then((a) => (ok(a) ? JSON.parse(a.text) as Stats : undefined), () => undefined);
      if (stats) {
        const cpu = cpuOf(id, stats);
        if (cpu !== undefined) reading.cpuCores = cpu;
        const mem = memUsed(stats.memory_stats);
        if (mem !== undefined) reading.memUsedBytes = mem;
        const max = stats.memory_stats?.limit;
        if (count(max) && max > 0) reading.memMaxBytes = max;
        const cores = stats.cpu_stats?.online_cpus;
        if (count(cores) && cores > 0) reading.cores = cores;
        const nets = Object.values(stats.networks ?? {});
        const rx = sum(nets.map((n) => n.rx_bytes));
        const tx = sum(nets.map((n) => n.tx_bytes));
        if (rx !== undefined) reading.netRxBytes = rx;
        if (tx !== undefined) reading.netTxBytes = tx;
        const read = diskBytes(stats, 'read');
        const write = diskBytes(stats, 'write');
        if (read !== undefined) reading.diskReadBytes = read;
        if (write !== undefined) reading.diskWriteBytes = write;
      }
      const layer = disk?.layers.get(id);
      if (layer !== undefined) reading.layerBytes = layer;
    }
    const volumes = (inspected?.Mounts ?? []).flatMap((m) => (m.Type === 'volume' && m.Name ? [m.Name] : []));
    if (volumes.length) {
      reading.volumes = volumes.map((name) => {
        const bytes = disk?.volumes.get(name);
        return bytes === undefined ? { name } : { name, bytes };
      });
    }
    return reading;
  };

  return {
    async read() {
      let listed: Answer;
      try {
        listed = await call('/containers/json?all=true');
      } catch (e) {
        return { problem: `cannot reach the container runtime ${o.machine !== undefined ? `on ${o.machine}` : `at ${socketName(o.socket)}`}: ${e instanceof Error ? e.message : String(e)}` };
      }
      if (!ok(listed)) return { problem: refusal('the container runtime', 'list containers', listed).message };
      const all = JSON.parse(listed.text) as Listed[];
      const own = all.find((c) => o.self.length > 0 && c.Id?.startsWith(o.self));
      // On a client target, no compose project is the hopper's: only its boxes.
      const project = o.machine !== undefined ? undefined : own?.Labels?.[PROJECT_LABEL] ?? DEFAULT_PROJECT;
      const chosen = all.flatMap((c): { c: Listed; group: ContainerGroup; service: string }[] => {
        const labels = c.Labels ?? {};
        if (project !== undefined && labels[PROJECT_LABEL] === project) return [{ c, group: 'stack', service: labels[SERVICE_LABEL] ?? nameOf(c) }];
        if (labels[BOX_LABEL] === o.instanceId) return [{ c, group: 'sandbox', service: o.machine !== undefined ? `${o.machine}/${nameOf(c)}` : nameOf(c) }];
        return [];
      }).sort((a, b) => (a.group === b.group ? a.service.localeCompare(b.service) : a.group === 'stack' ? -1 : 1));
      const disk = o.machine === undefined && chosen.some((x) => x.c.State === 'running') ? await diskUse() : undefined;
      const containers = await Promise.all(chosen.map((x) => readOne(x.c, x.group, x.service, disk)));
      // A container that is gone forgets its CPU time.
      const ids = new Set(chosen.map((x) => x.c.Id));
      for (const id of lastCpu.keys()) if (!ids.has(id)) lastCpu.delete(id);
      return { containers };
    },
  };
}
