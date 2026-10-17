// How the Resources page writes the telemetry summary (issue #1486, design.md "Telemetry summary").
import { duration } from './format';
import type { TelemetrySummary } from './wire';

/** A time: `40.5 ms` under a second, `1.5 s` under a minute, then as `duration` (`2m 5s`, `1h 30m`). */
export function msText(ms: number): string {
  if (ms < 1000) return `${Math.round(ms * 100) / 100} ms`;
  if (ms < 60_000) return `${Math.round(ms / 10) / 100} s`;
  return duration(ms / 1000);
}

/** `50 GitHub calls, 30 from the cache (60%)`. */
export function githubTotalText(t: Pick<TelemetrySummary, 'githubCalls' | 'githubCacheHits'>): string {
  if (t.githubCalls === 0) return 'No GitHub call yet.';
  const share = Math.round((t.githubCacheHits / t.githubCalls) * 100);
  return `${t.githubCalls} GitHub calls, ${t.githubCacheHits} from the cache (${share}%).`;
}

export function exportText(exporting: boolean): string {
  return exporting
    ? 'Kept in the hopper since it started, and also exported to the OpenTelemetry collector the launch names.'
    : 'Kept in the hopper since it started, and not exported: set the launch\'s OTEL_* variables to send traces, metrics and logs to a collector.';
}
