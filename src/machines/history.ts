// The resource recorder (issue #560, design.md "Machine resources over time"): every minute it lists the user's
// machines and keeps, for each one online with a reading, a machine sample — its CPU, memory and swap as its probe
// last read them, its disk, its lanes in use, the memory its jobs with no lane hold, its memory pressure and CPU throttle (issue #2499),
// and the hopper's own disk use and its caches from the sweep's last measure there (issue #2494). A machine offline adds nothing, which the resource graph shows as
// a gap. New samples are told to listeners (SSE `machine.recorded`). Every hour, and when the history retention
// changes, samples past it are pruned: the same retention as the usage samples. Each record also shows the machines
// to the memory alert (issue #868).
import type { Clock, MachineHistoryRepository } from '../domain/ports.ts';
import { diskUseOf, freshMeasure, type DiskMeasure, type Lane, type MachineSample, type MachineSnapshot } from '../domain/types.ts';
import { createRecordLoop } from '../usage/history.ts';

const DAY_MS = 86_400_000;

export interface ResourceRecorder {
  /** Keep a machine sample of every machine online with a reading now; how many were new. */
  record(): Promise<number>;
  /** Call `listener` with how many samples were new, each time a record keeps any; returns the unsubscribe. */
  onRecorded(listener: (added: number) => void): () => void;
  /** Delete the samples past the history retention; how many. */
  prune(): number;
  start(): void;
  stop(): void;
}

/** Issue #2499: the memory the machine's job scopes hold for jobs with no lane in use there. */
export function waitingMemory(jobs: Readonly<Record<string, number>>, machineId: string, lanes: readonly Lane[]): number {
  const onLane = new Set(lanes.flatMap((l) => (l.machineId === machineId && l.state !== 'idle' && l.jobId !== undefined ? [l.jobId] : [])));
  return Object.entries(jobs).reduce((n, [id, bytes]) => (onLane.has(id) ? n : n + bytes), 0);
}

/** The sample a machine gives now, with its last disk measure; undefined when it is offline or read nothing. */
export function sampleOf(m: MachineSnapshot, lanes: readonly Lane[], at: string, measure?: DiskMeasure): MachineSample | undefined {
  if (!m.online || (!m.resources && !m.disk)) return undefined;
  const r = m.resources;
  const fresh = freshMeasure(measure, at), use = fresh ? diskUseOf(fresh) : undefined;
  return {
    machineId: m.id, at,
    ...(r ? { cores: r.cores, memTotalBytes: r.memTotalBytes, memAvailableBytes: r.memAvailableBytes } : {}),
    ...(r?.cpuBusyFrac !== undefined ? { cpuBusyFrac: r.cpuBusyFrac } : {}),
    ...(r?.load ? { load1: r.load[0] } : {}),
    ...(r?.swapTotalBytes !== undefined && r.swapUsedBytes !== undefined ? { swapTotalBytes: r.swapTotalBytes, swapUsedBytes: r.swapUsedBytes } : {}),
    ...(m.disk ? { diskFreeBytes: m.disk.freeBytes, diskTotalBytes: m.disk.totalBytes } : {}),
    ...(r?.vmHeldBytes !== undefined ? { vmHeldBytes: r.vmHeldBytes } : {}),
    ...(r?.hostMemFreeBytes !== undefined && r.hostMemTotalBytes !== undefined ? { hostMemFreeBytes: r.hostMemFreeBytes, hostMemTotalBytes: r.hostMemTotalBytes } : {}),
    ...(r?.jobMemoryBytes ? { waitingMemBytes: waitingMemory(r.jobMemoryBytes, m.id, lanes) } : {}),
    ...(r?.memPressure ? { memPressureFrac: r.memPressure.someAvg10 / 100 } : {}),
    ...(r?.cpuThrottledFrac !== undefined ? { cpuThrottledFrac: r.cpuThrottledFrac } : {}),
    ...(use ? { hopperDiskBytes: use.hopperBytes } : {}),
    ...(use?.cacheBytes !== undefined ? { cacheDiskBytes: use.cacheBytes } : {}),
    lanesBusy: lanes.filter((l) => l.machineId === m.id && l.state !== 'idle').length,
    lanesMax: m.maxLanes,
  };
}

export function createResourceRecorder(o: {
  machines: () => Promise<MachineSnapshot[]>;
  lanes: () => Lane[];
  history: MachineHistoryRepository;
  retentionDays: () => number;
  clock: Clock;
  logger?: { warn(line: string): void };
  /** Each machine's last disk measure (issue #2494); absent, none. */
  diskMeasures?: () => Array<[string, DiskMeasure]>;
  /** Shown every machine at each record, after its samples are kept: the memory alert (issue #868). */
  observe?: (machines: readonly MachineSnapshot[], at: string) => void;
}): ResourceRecorder {
  const listeners = new Set<(added: number) => void>();
  const record = async (): Promise<number> => {
    const machines = await o.machines();
    const lanes = o.lanes();
    const at = o.clock.now().toISOString();
    const measures = new Map(o.diskMeasures?.() ?? []);
    const samples = machines.flatMap((m) => sampleOf(m, lanes, at, measures.get(m.id)) ?? []);
    const added = samples.length ? o.history.record(samples) : 0;
    o.observe?.(machines, at);
    if (added > 0) for (const l of listeners) l(added);
    return added;
  };
  const prune = (): number => o.history.prune(new Date(o.clock.now().getTime() - o.retentionDays() * DAY_MS));
  const loop = createRecordLoop({ what: 'machine history', record, prune, ...(o.logger ? { logger: o.logger } : {}) });
  return {
    record,
    onRecorded(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    prune,
    start: loop.start,
    stop: loop.stop,
  };
}
