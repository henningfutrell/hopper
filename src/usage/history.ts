// The usage history's recorder (issue #385, design.md "Usage history"): every minute it reads every usage
// source of the user — the live set, as the plugins config names it now — and keeps each reading as a usage
// sample. A source answers from its last read until it reads again, so a sample is kept once per read: at
// the source's own poll interval. A source with no readings (failing, offline, stale) adds nothing, which
// the graph shows as a gap. Every hour, and when the retention changes, samples past it are pruned.
import type { Clock, UsageHistoryRepository } from '../domain/ports.ts';
import type { UsageReading, UsageSample, UsageSourceReport } from '../domain/types.ts';

const RECORD_EVERY_MS = 60_000;
const PRUNE_EVERY_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface UsageRecorder {
  /** Keep the readings every usage source gives now; how many were new. */
  record(): Promise<number>;
  /** Delete the samples past the history retention; how many. */
  prune(): number;
  start(): void;
  stop(): void;
}

export function createUsageRecorder(o: {
  readings: () => Promise<UsageReading[]>;
  sources: () => UsageSourceReport[];
  history: UsageHistoryRepository;
  retentionDays: () => number;
  clock: Clock;
  logger?: { warn(line: string): void };
}): UsageRecorder {
  let timers: NodeJS.Timeout[] = [];
  let failing = false;
  const logger = o.logger ?? console;

  const record = async (): Promise<number> => {
    const readings = await o.readings();
    const accounts = new Map(o.sources().flatMap((s) => (s.account?.identity ? [[s.name, s.account.identity] as const] : [])));
    const samples = readings.map((r): UsageSample => {
      const account = accounts.get(r.source);
      return account === undefined ? r : { ...r, account };
    });
    return samples.length ? o.history.record(samples) : 0;
  };
  const prune = (): number => o.history.prune(new Date(o.clock.now().getTime() - o.retentionDays() * DAY_MS));

  /** One failure logged until it works again: a database away for a while is one line, not one a minute. */
  const guarded = (what: string, fn: () => unknown) => async () => {
    try {
      await fn();
      failing = false;
    } catch (e) {
      if (!failing) logger.warn(`hopper: usage history: ${what} failed: ${e instanceof Error ? e.message : String(e)}`);
      failing = true;
    }
  };

  return {
    record,
    prune,
    start() {
      if (timers.length) return;
      timers = [setInterval(guarded('record', record), RECORD_EVERY_MS), setInterval(guarded('prune', prune), PRUNE_EVERY_MS)];
      for (const t of timers) t.unref();
      void guarded('record', record)();
      void guarded('prune', prune)();
    },
    stop() {
      for (const t of timers) clearInterval(t);
      timers = [];
    },
  };
}
