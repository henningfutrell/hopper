// Telemetry in Settings, in the UI (issue #1486), pure: the line that says where the telemetry's config comes from, and a
// signal ticked or not. The UI takes only types of src/, so the signals are listed here again, in their order.
import type { TelemetrySettingsView, TelemetrySignal } from './wire.ts';

export const SIGNALS: readonly TelemetrySignal[] = ['traces', 'metrics', 'logs'];

const list = (words: readonly string[]): string => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`);

/** Where the config comes from, and what is exported. */
export function telemetrySourceLine(view: TelemetrySettingsView): string {
  if (view.source === 'launch') return 'The launch\'s OTEL_* variables configure telemetry: they win, and this setting is only kept until they name no exporter.';
  if (view.source === 'settings') return `Exporting ${list(view.settings.signals)} to ${view.settings.endpoint} (OTLP, HTTP and protobuf).`;
  return 'Off: nothing is exported.';
}

/** The signals with `signal` on or off, in their order. */
export const toggleSignal = (signals: readonly TelemetrySignal[], signal: TelemetrySignal, on: boolean): TelemetrySignal[] =>
  SIGNALS.filter((s) => (s === signal ? on : signals.includes(s)));
