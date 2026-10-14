// The usage history's recorder (issue #385, design.md "Usage history"): every minute it reads every usage
// source of the user — the live set, as the plugins config names it now — and keeps each reading as a usage
// sample. A source answers from its last read until it reads again, so a sample is kept once per read: at
// the source's own poll interval. A source with no readings (failing, offline, stale) adds nothing, which
// the graph shows as a gap. New samples are told to listeners (SSE `usage.recorded`, issue #502). Every hour,
// and when the retention changes, samples past it are pruned.
import type { Clock, UsageHistoryRepository } from '../domain/ports.ts';
import type { UsageReading, UsageSample, UsageSourceReport } from '../domain/types.ts';

const RECORD_EVERY_MS = 60_000;
const PRUNE_EVERY_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface UsageRecorder {
  /** Keep the readings every usage source gives now; how many were new. */
  record(): Promise<number>;
  /** Call `listener` with how many samples were new, each time a record keeps any; returns the unsubscribe. */
  onRecorded(listener: (added: number) => void): () => void;
  /** Delete the samples past the history retention; how many. */
  prune(): number;
  start(): void;
  stop(): void;
}

/** A recorder's timers (the usage recorder's, and the resource recorder's, issue #560): a record every minute and a prune every hour, both at once at start. */
export interface RecordLoop {
  start(): void;
  stop(): void;
}

export function createRecordLoop(o: { what: string; record: () => unknown; prune: () => unknown; logger?: { warn(line: string): void } }): RecordLoop {
  let timers: NodeJS.Timeout[] = [];
  let failing = false;
  const logger = o.logger ?? console;
  /** One failure logged until it works again: a database away for a while is one line, not one a minute. */
  const guarded = (what: string, fn: () => unknown) => async () => {
    try {
      await fn();
      failing = false;
    } catch (e) {
      if (!failing) logger.warn(`hopper: ${o.what}: ${what} failed: ${e instanceof Error ? e.message : String(e)}`);
      failing = true;
    }
  };
  return {
    start() {
      if (timers.length) return;
      timers = [setInterval(guarded('record', o.record), RECORD_EVERY_MS), setInterval(guarded('prune', o.prune), PRUNE_EVERY_MS)];
      for (const t of timers) t.unref();
      void guarded('record', o.record)();
      void guarded('prune', o.prune)();
    },
    stop() {
      for (const t of timers) clearInterval(t);
      timers = [];
    },
  };
}

export function createUsageRecorder(o: {
  readings: () => Promise<UsageReading[]>;
  sources: () => UsageSourceReport[];
  history: UsageHistoryRepository;
  retentionDays: () => number;
  clock: Clock;
  logger?: { warn(line: string): void };
}): UsageRecorder {
  const listeners = new Set<(added: number) => void>();

  const record = async (): Promise<number> => {
    const readings = await o.readings();
    const accounts = new Map(o.sources().flatMap((s) => (s.account?.identity ? [[s.name, s.account.identity] as const] : [])));
    const samples = readings.map((r): UsageSample => {
      const account = accounts.get(r.source);
      return account === undefined ? r : { ...r, account };
    });
    const added = samples.length ? o.history.record(samples) : 0;
    if (added > 0) for (const l of listeners) l(added);
    return added;
  };
  const prune = (): number => o.history.prune(new Date(o.clock.now().getTime() - o.retentionDays() * DAY_MS));
  const loop = createRecordLoop({ what: 'usage history', record, prune, ...(o.logger ? { logger: o.logger } : {}) });

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
