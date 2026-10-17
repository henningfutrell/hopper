// The telemetry summary (issue #1486, design.md "Telemetry summary"): the most useful numbers of the hopper's telemetry —
// the slowest actions, how long each kind of job span lasts, the GitHub calls by route — kept in the hopper's own
// process, telemetry on or off, so the Resources page shows them with no collector. The same places that record the
// OpenTelemetry instruments feed it (`http.ts`, `jobs.ts`, the GitHub limiter), so it shows what is exported. Names
// only: a route's template, a job span's kind; never a URL, an id or a value. In memory: a restart starts it again.
//
// One per process, as the meter provider is: an action, a job span and a GitHub call are the process's, whichever
// user's they are. Each name keeps its count and its last samples; the names are bounded (`MAX_NAMES`) by the routes
// and job spans there are.
import {
  TELEMETRY_SUMMARY_SAMPLES, TELEMETRY_SUMMARY_TOP, type GitHubUseStat, type TelemetrySummary, type TimingStat,
} from '../domain/types.ts';

/** The most names each list keeps: past it, a new name is not kept. Route templates and job spans stay far under it. */
const MAX_NAMES = 500;

/** A read is no action: only a request that changes something is. */
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

interface Timings { count: number; samples: number[]; next: number }
interface GitHubTimings extends Timings { cacheHits: number; errors: number }

function sample(t: Timings, ms: number): void {
  t.count++;
  if (t.samples.length < TELEMETRY_SUMMARY_SAMPLES) t.samples.push(ms);
  else t.samples[t.next] = ms;
  t.next = (t.next + 1) % TELEMETRY_SUMMARY_SAMPLES;
}

const round = (ms: number): number => Math.round(ms * 100) / 100;

function stat(name: string, t: Timings): TimingStat {
  const sorted = [...t.samples].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length);
  // Nearest rank: the smallest sample at or above 95% of them.
  const p95 = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
  return { name, count: t.count, meanMs: round(mean), p95Ms: round(p95), maxMs: round(sorted.at(-1) ?? 0) };
}

const slowestFirst = (a: TimingStat, b: TimingStat): number => b.p95Ms - a.p95Ms || b.maxMs - a.maxMs || a.name.localeCompare(b.name);

export interface TelemetrySummaryKeeper {
  /** A request answered, `seconds` after it came: an action unless it is a read. `route`: its template; none, no route matched. */
  action(method: string, route: string | undefined, seconds: number): void;
  /** A job span that ended, `ms` long. */
  jobSpan(kind: string, ms: number): void;
  /** A GitHub call answered (`status`; none: no answer), `seconds` after it was sent. */
  githubCall(method: string, route: string, status: number | undefined, cache: 'hit' | 'miss' | 'none', seconds: number): void;
  /** Whether the launch's telemetry is also exported. */
  exporting(on: boolean): void;
  read(): TelemetrySummary;
  /** Tests: forget everything kept. */
  reset(): void;
}

export function createTelemetrySummary(now: () => Date = () => new Date()): TelemetrySummaryKeeper {
  const since = now().toISOString();
  let exporting = false;
  let actions = new Map<string, Timings>();
  let jobSpans = new Map<string, Timings>();
  let github = new Map<string, GitHubTimings>();
  let githubCalls = 0;
  let githubCacheHits = 0;
  const timings = <T extends Timings>(m: Map<string, T>, name: string, make: () => T): T | undefined => {
    const known = m.get(name);
    if (known) return known;
    if (m.size >= MAX_NAMES) return undefined;
    const t = make();
    m.set(name, t);
    return t;
  };
  const fresh = (): Timings => ({ count: 0, samples: [], next: 0 });
  return {
    action(method, route, seconds) {
      if (!route || READS.has(method)) return;
      const t = timings(actions, `${method} ${route}`, fresh);
      if (t) sample(t, seconds * 1000);
    },
    jobSpan(kind, ms) {
      const t = timings(jobSpans, kind, fresh);
      if (t) sample(t, ms);
    },
    githubCall(method, route, status, cache, seconds) {
      githubCalls++;
      if (cache === 'hit') githubCacheHits++;
      const t = timings(github, `${method} ${route}`, () => ({ ...fresh(), cacheHits: 0, errors: 0 }));
      if (!t) return;
      sample(t, seconds * 1000);
      if (cache === 'hit') t.cacheHits++;
      if (status === undefined || status >= 400) t.errors++;
    },
    exporting(on) { exporting = on; },
    read() {
      return {
        since, exporting,
        actions: [...actions].map(([n, t]) => stat(n, t)).sort(slowestFirst).slice(0, TELEMETRY_SUMMARY_TOP),
        jobSpans: [...jobSpans].map(([n, t]) => stat(n, t)).sort(slowestFirst),
        github: [...github].map(([n, t]): GitHubUseStat => ({ ...stat(n, t), cacheHits: t.cacheHits, errors: t.errors }))
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, TELEMETRY_SUMMARY_TOP),
        githubCalls, githubCacheHits,
      };
    },
    reset() {
      actions = new Map(); jobSpans = new Map(); github = new Map(); githubCalls = 0; githubCacheHits = 0; exporting = false;
    },
  };
}

/** The process's summary: what `GET /api/telemetry` answers. */
export const telemetrySummary = createTelemetrySummary();
