// What the built-in usage sources share (design.md "Usage and accounts (issue #18)", "Usage per
// executor (issue #140)"): a read in the background, once at create and then every
// `intervalSeconds`; `poll` answers from the last good read and never waits; a budget past its
// reset is left out; readings older than 3 intervals are stale. Each reading names the instance,
// the machine it is of (if any, issue #139) and the executors whose jobs it limits.
import type { Account, UsageReading, UsageSourceState } from '../../domain/types.ts';
import type { UsageSource } from '../../domain/ports.ts';

/** One budget as a read finds it; the source, executors and time are added here. */
export type Budget = Pick<UsageReading, 'used' | 'limit' | 'unit' | 'window' | 'resetsAt' | 'informational'>;

/**
 * What one read found: budgets or why not, and the account if it read one. `notReady`: what it reads
 * was not there yet (a machine not listed or not probed online): read again soon, not an interval later.
 */
export type Read = ({ budgets: Budget[]; machineId?: string } | { problem: string }) & { account?: Account; notReady?: boolean };

export interface PolledContext {
  clock: { now(): Date };
  logger: { info(l: string): void; warn(l: string): void };
  instanceName: string;
}

/** Readings older than this many intervals are stale: none are returned. */
const STALE_INTERVALS = 3;
/** A read that was not ready is tried again after this long, on a poll. */
const NOT_READY_RETRY_MS = 30_000;

export function createPolledUsageSource(
  ctx: PolledContext,
  o: { intervalSeconds: number; machineId?: string; executors?: string[]; read(signal: AbortSignal): Promise<Read> },
): UsageSource {
  const staleMs = STALE_INTERVALS * o.intervalSeconds * 1000;
  let budgets: Budget[] = [];
  /** The machine the last good read was of, when the source names none (issue #442). */
  let readOf: string | undefined;
  let refreshedAt: Date | undefined;
  let lastError: string | undefined;
  let account: Account | undefined;
  let running: Promise<void> | undefined;
  let retryAt: number | undefined;
  let stopped = false;
  const abort = new AbortController();

  const note = (problem: string | undefined) => {
    if (problem === lastError) return;
    if (problem) ctx.logger.warn(`hopper: usage source ${ctx.instanceName}: ${problem}`);
    else ctx.logger.info(`hopper: usage source ${ctx.instanceName}: reading usage`);
    lastError = problem;
  };

  const refresh = async (): Promise<void> => {
    const r = await o.read(abort.signal);
    if (stopped) return;
    retryAt = r.notReady ? ctx.clock.now().getTime() + NOT_READY_RETRY_MS : undefined;
    if ('budgets' in r) {
      budgets = r.budgets;
      readOf = r.machineId;
      refreshedAt = ctx.clock.now();
    }
    note('problem' in r ? r.problem : undefined);
    account = r.account;
  };

  const kick = () => {
    if (running || stopped) return;
    running = refresh()
      .catch((e: unknown) => note(`refresh failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => { running = undefined; });
  };

  const stale = (now: Date) => refreshedAt !== undefined && now.getTime() - refreshedAt.getTime() > staleMs;

  kick();
  const timer = setInterval(kick, o.intervalSeconds * 1000);
  timer.unref();

  return {
    name: ctx.instanceName,
    async poll(): Promise<UsageReading[]> {
      const now = ctx.clock.now();
      if (retryAt !== undefined && now.getTime() >= retryAt && !running) {
        retryAt = undefined;
        kick();
      }
      if (!refreshedAt || stale(now)) return [];
      const at = refreshedAt.toISOString();
      // A budget past its reset no longer says anything: it is left out until the next read.
      const machineId = o.machineId ?? readOf;
      return budgets.filter((b) => !b.resetsAt || Date.parse(b.resetsAt) > now.getTime()).map((b) => ({
        source: ctx.instanceName, ...(machineId ? { machineId } : {}), ...b, ...(o.executors ? { executors: [...o.executors] } : {}), at,
      }));
    },
    state(): UsageSourceState {
      const now = ctx.clock.now();
      const problem = stale(now)
        ? `stale: last read ${refreshedAt!.toISOString()}${lastError ? ` (${lastError})` : ''}`
        : (lastError ?? (refreshedAt ? undefined : 'not read yet'));
      return {
        ...(refreshedAt ? { refreshedAt: refreshedAt.toISOString() } : {}),
        ...(problem ? { problem } : {}),
        ...(account ? { account } : {}),
      };
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      abort.abort();
    },
  };
}

/** The `executors` option every built-in usage source has: the executor instances whose jobs it limits. */
export const EXECUTORS_DESCRIPTION = 'executor instances whose jobs this budget limits (absent: every job)';
