// A job source's status (/api/sources, SSE source.updated). Re-exported by types.ts.

export interface SourceStatus {
  name: string;
  kind: string;
  /** ok: last sync succeeded. error: last sync failed. disabled: configured off. starting: no sync yet. */
  state: 'ok' | 'error' | 'disabled' | 'starting';
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
 * `sync:<act>` for the sync an act asks for.
 */
export interface AfterAnswerTiming {
  act: string;
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
