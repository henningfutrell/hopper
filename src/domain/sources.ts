// A job source's status (/api/sources, SSE source.updated). Re-exported by types.ts.

/**
 * Why a job source that is on cannot run (issue #1243): the required config it lacks, by name — for the app source its
 * `appId`, its `slug`, the variable of its private key —, or a value that is wrong. `help`: the help page that walks
 * through its setup.
 */
export interface SetupProblem {
  /** The config not set, by name; empty when what is set is wrong (`reason` says what). */
  missing: string[];
  /** What is missing or wrong, in a line. */
  reason: string;
  /** The help page's slug (`/help/<help>`). */
  help: string;
}

export interface SourceStatus {
  name: string;
  kind: string;
  /**
   * ok: last sync succeeded. error: last sync failed. disabled: configured off. starting: no sync yet. needs-setup: on,
   * but not configured (`setupProblem`, issue #1243): it ran no sync pass.
   */
  state: 'ok' | 'error' | 'disabled' | 'starting' | 'needs-setup';
  /** Its setup problem while it has one (issue #1243). */
  setupProblem?: SetupProblem;
  lastSyncAt?: string;
  lastOkAt?: string;
  lastError?: string;
  /** When the source's timer syncs it next; absent while a sync runs (issue #812). */
  nextSyncAt?: string;
  /** A sync runs now (issue #812). */
  syncing?: true;
  /** Eligible items seen by the last discover. */
  itemsSeen: number;
  /** Jobs this source created since the daemon started. */
  jobsCreated: number;
  /** Non-terminal jobs from this source. */
  activeJobs: number;
  /** Source-specific facts for the UI, e.g. { owners, repos, authors, label }. */
  detail: Record<string, unknown>;
}

/** p50, p95 and max of a set of times, in ms. */
export interface TimingSpread { p50: number; p95: number; max: number }

/**
 * How the work after a person's act spent its time (issue #1194): per act, the time its runs waited on their queue (the
 * job's report chain, or the source's sync chain) apart from the time they ran; the last runs of each act since the
 * daemon started. `act` is a give-back act (`rerun`, `retry`, …), `merge` or `close`, an intake action's `approve`, `assign`, …; and
 * `sync:<act>` for the sync an act asks for; with `source`, an intake action's GitHub writes after it, in that source.
 */
export interface AfterAnswerTiming {
  act: string;
  /** The job source whose own work it is (part 8): an intake action's GitHub writes, its write-behind. Absent: the hopper's queues. */
  source?: string;
  /** Runs since the daemon started. */
  count: number;
  waitMs: TimingSpread;
  runMs: TimingSpread;
  /** When the last run ended. */
  lastAt: string;
}

/** A registry that times the work after each person's act (issue #1194). */
export interface AfterAnswerTimed {
  /** How the work after each person's act waited on its queue and ran, per act. */
  afterAnswerTimings(): AfterAnswerTiming[];
}
