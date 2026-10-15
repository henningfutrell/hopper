// Where the hopper's app is installed (issue #1250, design.md "Sign in with GitHub, and work through that connection"): the
// connected account's installations of the app, each with the repositories it reaches, as last read, kept in the database
// (`AppInstallationsRead`). The connected account's status answers only from it: showing it never reads GitHub. GitHub is
// read in the background, on Refresh (`refresh`), when an account is connected, or on the schedule (`tick`, every
// `TICK_MS`, when the read's `nextAt` passed or it is of another account: `FRESH_MS` after a read, a backoff from
// `RETRY_MS` that doubles with each failure in a row, at most `MAX_RETRY_MS`, and never before GitHub's rate limit lets
// it). One read per provider at a time: a Refresh while one runs joins it. Each read is conditional (conditional.ts), with
// the answers kept from the read before. A failed read keeps the installations read before, with why.
import { CONNECTED_ACCOUNT_PROVIDERS, type AppInstallation, type AppInstallationsReadRepository, type ConnectedAccountProvider, type ConnectedAccountStatus } from '../domain/types.ts';
import { conditionalAnswers, type ConditionalAnswers } from '../repo-checks/conditional.ts';

export type { ConditionalAnswers };
import { PROVIDER_NAME } from './at-rest.ts';

/** The schedule reads the installations again once their read is this old: 30 minutes. */
export const FRESH_MS = 30 * 60_000;
/** After a failed read, the schedule reads again this much later, doubled with each failure in a row. */
export const RETRY_MS = 60_000;
/** The longest backoff: as long as a read stays fresh. */
export const MAX_RETRY_MS = FRESH_MS;
/** How often the schedule looks for a read that is due. */
export const TICK_MS = 60_000;

export interface InstallationReadsOptions {
  reads: AppInstallationsReadRepository;
  /** The provider's connected account while its sign-in lives; undefined: nothing to read. */
  account(provider: ConnectedAccountProvider): string | undefined;
  /** The installations, read from GitHub now, each GET through `answers`. */
  read(provider: ConnectedAccountProvider, answers: ConditionalAnswers): Promise<AppInstallation[]>;
  now(): number;
  log(line: string): void;
  tickMs?: number;
}

/** The part of a connected account's status that says where the app is installed. */
export type InstallationsView = Pick<Extract<ConnectedAccountStatus, { state: 'connected' }>, 'installations' | 'installationsError' | 'installationsCheckedAt' | 'installationsReading'>;

export interface InstallationReads {
  /** What the database holds for `account`: never reads GitHub. */
  view(provider: ConnectedAccountProvider, account: string): InstallationsView;
  /** Reads the installations from GitHub now, or joins the read under way. */
  refresh(provider: ConnectedAccountProvider): Promise<void>;
  /** The schedule's pass: reads each provider whose read is due. */
  tick(): Promise<void>;
  /** Drops the kept read: the account was disconnected. */
  forget(provider: ConnectedAccountProvider): void;
  start(): void;
  stop(): Promise<void>;
}

/** The backoff after `failures` failed reads in a row. */
const backoff = (failures: number): number => Math.min(RETRY_MS * 2 ** Math.max(0, failures - 1), MAX_RETRY_MS);

export function createInstallationReads(o: InstallationReadsOptions): InstallationReads {
  const reading = new Map<ConnectedAccountProvider, Promise<void>>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let pass: Promise<void> | undefined;
  const iso = (t: number) => new Date(t).toISOString();

  async function readNow(provider: ConnectedAccountProvider, account: string): Promise<void> {
    const kept = o.reads.get(provider);
    const before = kept?.account === account ? kept : undefined;
    const at = o.now();
    const answers = conditionalAnswers(before?.etags);
    try {
      const installations = await o.read(provider, answers);
      o.reads.put({ provider, account, at: iso(at), nextAt: iso(at + FRESH_MS), failures: 0, installations, etags: answers.kept() });
    } catch (e) {
      const failures = (before?.failures ?? 0) + 1;
      const error = `${PROVIDER_NAME[provider]} could not say where the app is installed: ${(e as Error).message}`;
      o.log(`hopper: ${error}`);
      o.reads.put({
        ...(before ?? { etags: {} }), provider, account, failures, error,
        nextAt: iso(Math.max(at + backoff(failures), (e as { retryAt?: number }).retryAt ?? 0)),
      });
    }
  }

  const refresh = (provider: ConnectedAccountProvider): Promise<void> => {
    const now = reading.get(provider);
    if (now) return now;
    const account = o.account(provider);
    if (account === undefined) return Promise.resolve();
    const p = readNow(provider, account).catch((e: unknown) => { o.log(`hopper: installations: ${(e as Error).message}`); }).finally(() => reading.delete(provider));
    reading.set(provider, p);
    return p;
  };

  const due = (provider: ConnectedAccountProvider): boolean => {
    const account = o.account(provider);
    if (account === undefined) return false;
    const r = o.reads.get(provider);
    return !r || r.account !== account || Date.parse(r.nextAt) <= o.now();
  };

  const tick = (): Promise<void> => {
    pass ??= Promise.all(CONNECTED_ACCOUNT_PROVIDERS.filter(due).map(refresh)).then(() => undefined).finally(() => { pass = undefined; });
    return pass;
  };

  return {
    view(provider, account) {
      const r = o.reads.get(provider);
      const mine = r?.account === account ? r : undefined;
      return {
        ...(mine?.installations ? { installations: mine.installations } : {}),
        ...(mine?.error ? { installationsError: mine.error } : {}),
        ...(mine?.at ? { installationsCheckedAt: mine.at } : {}),
        ...(reading.has(provider) ? { installationsReading: true as const } : {}),
      };
    },
    refresh,
    tick,
    forget(provider) { o.reads.remove(provider); },
    start() {
      if (timer) return;
      timer = setInterval(() => { void tick(); }, o.tickMs ?? TICK_MS);
      timer.unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await pass;
      await Promise.all(reading.values());
    },
  };
}
