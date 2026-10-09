// The resource recorder (issue #560, design.md "Machine resources over time"): every minute it lists the user's
// machines and keeps, for each one online with a reading, a machine sample — its CPU, memory and swap as its probe
// last read them, its disk, and its lanes in use. A machine offline adds nothing, which the resource graph shows as
// a gap. New samples are told to listeners (SSE `machine.recorded`). Every hour, and when the history retention
// changes, samples past it are pruned: the same retention as the usage samples.
import type { Clock, MachineHistoryRepository } from '../domain/ports.ts';
import type { Lane, MachineSample, MachineSnapshot } from '../domain/types.ts';
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

/** The sample a machine gives now; undefined when it is offline or read nothing. */
export function sampleOf(m: MachineSnapshot, lanes: readonly Lane[], at: string): MachineSample | undefined {
  if (!m.online || (!m.resources && !m.disk)) return undefined;
  const r = m.resources;
  return {
    machineId: m.id, at,
    ...(r ? { cores: r.cores, memTotalBytes: r.memTotalBytes, memAvailableBytes: r.memAvailableBytes } : {}),
    ...(r?.cpuBusyFrac !== undefined ? { cpuBusyFrac: r.cpuBusyFrac } : {}),
    ...(r?.load ? { load1: r.load[0] } : {}),
    ...(r?.swapTotalBytes !== undefined && r.swapUsedBytes !== undefined ? { swapTotalBytes: r.swapTotalBytes, swapUsedBytes: r.swapUsedBytes } : {}),
    ...(m.disk ? { diskFreeBytes: m.disk.freeBytes, diskTotalBytes: m.disk.totalBytes } : {}),
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
}): ResourceRecorder {
  const listeners = new Set<(added: number) => void>();
  const record = async (): Promise<number> => {
    const machines = await o.machines();
    const lanes = o.lanes();
    const at = o.clock.now().toISOString();
    const samples = machines.flatMap((m) => sampleOf(m, lanes, at) ?? []);
    const added = samples.length ? o.history.record(samples) : 0;
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
