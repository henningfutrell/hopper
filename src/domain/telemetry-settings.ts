// The telemetry setting (issue #1486, design.md "Telemetry settings"): the hopper's admin's, in Settings → Telemetry or
// through the API, never in a file — whether the hopper exports its traces, metrics and logs, to which OTLP endpoint
// (HTTP and protobuf), and which signals. It applies only while the launch's OTEL_* variables name no exporter: the launch
// wins. A credential the collector needs (a header) is given at launch (`OTEL_EXPORTER_OTLP_HEADERS`), never kept here.
// Pure.

export const TELEMETRY_SIGNALS = ['traces', 'metrics', 'logs'] as const;
export type TelemetrySignal = (typeof TELEMETRY_SIGNALS)[number];

/** As kept in the instance's settings (`telemetry`). */
export interface TelemetrySettings {
  on: boolean;
  /** The OTLP base URL; each signal goes to `<endpoint>/v1/<signal>`. Empty: none yet. */
  endpoint: string;
  signals: TelemetrySignal[];
}

export const DEFAULT_TELEMETRY_SETTINGS: TelemetrySettings = { on: false, endpoint: '', signals: [...TELEMETRY_SIGNALS] };

/** Why `endpoint` is no OTLP endpoint; undefined: it is one. No user, password, query or fragment: a credential goes at launch. */
export function telemetryEndpointProblem(endpoint: string): string | undefined {
  let url: URL;
  try { url = new URL(endpoint.trim()); } catch { return 'the endpoint is an http or https URL, for example http://collector:4318'; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'the endpoint is an http or https URL';
  if (url.hostname === '') return 'the endpoint names a host';
  if (url.username || url.password) return 'the endpoint has no user or password: give a credential as a header at launch (OTEL_EXPORTER_OTLP_HEADERS)';
  if (url.search || url.hash) return 'the endpoint has no query and no fragment';
  return undefined;
}

/** Why `s` cannot be kept; undefined: it can. */
export function telemetrySettingsProblem(s: TelemetrySettings): string | undefined {
  if (s.endpoint.trim() !== '') { const problem = telemetryEndpointProblem(s.endpoint); if (problem) return problem; }
  if (!s.on) return undefined;
  if (s.endpoint.trim() === '') return 'telemetry on needs an endpoint';
  if (s.signals.length === 0) return 'telemetry on needs a signal: traces, metrics or logs';
  return undefined;
}

/** The record as kept: the endpoint trimmed, with no trailing slash; the signals in their order, each once. */
export const telemetryRecord = (s: TelemetrySettings): TelemetrySettings => ({
  on: s.on, endpoint: s.endpoint.trim().replace(/\/+$/, ''), signals: TELEMETRY_SIGNALS.filter((x) => s.signals.includes(x)),
});

/** As GET /api/telemetry-settings answers it. */
export interface TelemetrySettingsView {
  settings: TelemetrySettings;
  /** Where the telemetry's config comes from now: the launch's OTEL_* variables (they win), the setting, or none: off. */
  source: 'launch' | 'settings' | 'off';
  /** Whether the hopper exports now. */
  exporting: boolean;
  /** The setting's OTLP protocol; another is set at launch. */
  protocol: 'http/protobuf';
}
