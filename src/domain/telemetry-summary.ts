// The telemetry summary (issue #1486, design.md "Telemetry summary"): the most useful numbers of the hopper's telemetry,
// kept in the hopper's own process so the Resources page shows them with no collector — the slowest actions, how long
// each job span lasts, and the GitHub calls. Names only: a route's template, a job span's kind, a GitHub route's template.

/** How long something took, over the last samples the hopper keeps of it. */
export interface TimingStat {
  /** A route's template (`POST /ui/api/jobs/:id/approve`), a job span's kind (`run`), or a GitHub route (`GET /repos/{owner}/{repo}/pulls`). */
  name: string;
  /** Since the hopper started. */
  count: number;
  /** Over the last samples kept (`TELEMETRY_SUMMARY_SAMPLES`). */
  meanMs: number;
  p95Ms: number;
  maxMs: number;
}

/** A GitHub route's calls: a conditional request GitHub answered 304, from the cache, is a cache hit. */
export interface GitHubUseStat extends TimingStat {
  cacheHits: number;
  /** Calls with no answer or an answer of 400 or more. */
  errors: number;
}

/** `GET /api/telemetry`. */
export interface TelemetrySummary {
  /** When the hopper started keeping it: its process's start. Nothing is stored. */
  since: string;
  /** Whether the hopper also exports its telemetry (the launch's `OTEL_*` variables name an exporter). */
  exporting: boolean;
  /** The slowest actions (requests that change something: not GET or HEAD), by p95, at most `TELEMETRY_SUMMARY_TOP`. */
  actions: TimingStat[];
  /** Each kind of job span that ended, slowest p95 first. */
  jobSpans: TimingStat[];
  /** The most called GitHub routes, at most `TELEMETRY_SUMMARY_TOP`. */
  github: GitHubUseStat[];
  /** Every GitHub call, and those answered from the cache. */
  githubCalls: number;
  githubCacheHits: number;
}

/** The samples kept of each name, for its mean, p95 and max. */
export const TELEMETRY_SUMMARY_SAMPLES = 200;
/** The most names a list shows. */
export const TELEMETRY_SUMMARY_TOP = 10;
