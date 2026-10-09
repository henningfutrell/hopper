// A job source's status (/api/sources, SSE source.updated). Re-exported by types.ts.

export interface SourceStatus {
  name: string;
  kind: string;
  /** ok: last sync succeeded. error: last sync failed. disabled: configured off. starting: no sync yet. */
  state: 'ok' | 'error' | 'disabled' | 'starting';
  lastSyncAt?: string;
  lastOkAt?: string;
  lastError?: string;
  nextSyncAt?: string;
  /** Eligible items seen by the last discover. */
  itemsSeen: number;
  /** Jobs this source created since the daemon started. */
  jobsCreated: number;
  /** Non-terminal jobs from this source. */
  activeJobs: number;
  /** Source-specific facts for the UI, e.g. { owners, repos, authors, label }. */
  detail: Record<string, unknown>;
}
