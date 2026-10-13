// The stack recorder (issue #947, design.md "Stack resources over time"): every minute it reads the stack resources and
// keeps, per service, a stack sample of each metric it can give as a share — a running container's CPU (of its CPU quota,
// else of the cores it sees) and memory (of the most it may use), Postgres's connections (of max_connections), and the
// share of OpenFGA's checks that failed since the record before. A part that cannot be read adds nothing, which the graph
// shows as a gap. Every hour, samples past the stack history retention are pruned.
import type { Clock } from '../domain/ports.ts';
import { STACK_HISTORY_RETENTION_DAYS, type OpenFgaReading, type StackHistoryRepository, type StackResources, type StackSample } from '../domain/types.ts';
import { createRecordLoop } from '../usage/history.ts';

const DAY_MS = 86_400_000;

export interface StackRecorder {
  /** Keep a stack sample of each service's metrics now; how many were new. */
  record(): Promise<number>;
  /** Delete the samples past the stack history retention; how many. */
  prune(): number;
  start(): void;
  stop(): void;
}

const share = (used: number | undefined, of: number | undefined): number | undefined =>
  used === undefined || of === undefined || !(of > 0) ? undefined : Math.min(1, Math.max(0, used / of));

/** The samples one read of the stack resources gives; `before`: OpenFGA's reading at the record before, if any. */
export function samplesOf(r: StackResources, before: OpenFgaReading | undefined): StackSample[] {
  const out: StackSample[] = [];
  const add = (service: string, group: StackSample['group'], metric: StackSample['metric'], value: number | undefined) => {
    if (value !== undefined && Number.isFinite(value)) out.push({ at: r.at, service, group, metric, value });
  };
  // The containers beside the hopper, and the sandbox boxes on each client target, labelled `<machine>/<name>`.
  const containers = [...('containers' in r.containers ? r.containers.containers : []), ...r.remoteBoxes.flatMap((m) => ('containers' in m ? m.containers : []))];
  for (const c of containers) {
    if (c.state !== 'running') continue;
    add(c.service, c.group, 'cpu', share(c.cpuCores, c.cpuLimitCores ?? c.cores));
    add(c.service, c.group, 'memory', share(c.memUsedBytes, c.memLimitBytes ?? c.memMaxBytes));
  }
  if (!('problem' in r.postgres)) add('postgres', 'stack', 'connections', share(r.postgres.connections.total, r.postgres.connections.max));
  if (!('problem' in r.openfga) && before) {
    // OpenFGA's counters count since it started: fewer than before, it restarted, and this record says nothing.
    const checks = r.openfga.checks - before.checks;
    const errors = r.openfga.errors - before.errors;
    if (checks > 0 && errors >= 0) add('openfga', 'stack', 'check-errors', share(errors, checks));
  }
  return out;
}

export function createStackRecorder(o: {
  read: () => Promise<StackResources>;
  history: StackHistoryRepository;
  clock: Clock;
  logger?: { warn(line: string): void };
}): StackRecorder {
  let openfga: OpenFgaReading | undefined;
  const record = async (): Promise<number> => {
    const r = await o.read();
    const samples = samplesOf(r, openfga);
    openfga = 'problem' in r.openfga ? undefined : r.openfga;
    return samples.length ? o.history.record(samples) : 0;
  };
  const prune = (): number => o.history.prune(new Date(o.clock.now().getTime() - STACK_HISTORY_RETENTION_DAYS * DAY_MS));
  const loop = createRecordLoop({ what: 'stack history', record, prune, ...(o.logger ? { logger: o.logger } : {}) });
  return { record, prune, start: loop.start, stop: loop.stop };
}
