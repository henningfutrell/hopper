// The telemetry setting (issue #1486, design.md "Telemetry settings"), apart from settings.ts for its size: the instance's
// key-value setting `telemetry`, absent until the admin first saves it. A record of another shape reads as the default.
import { DEFAULT_TELEMETRY_SETTINGS, telemetryRecord, TELEMETRY_SIGNALS, type TelemetrySettings } from '../domain/telemetry-settings.ts';

export function telemetrySettings(read: (key: string) => string | undefined, write: (key: string, value: string) => void): {
  getTelemetry(): TelemetrySettings;
  setTelemetry(settings: TelemetrySettings): void;
} {
  return {
    getTelemetry() {
      const text = read('telemetry');
      if (text === undefined) return { ...DEFAULT_TELEMETRY_SETTINGS, signals: [...DEFAULT_TELEMETRY_SETTINGS.signals] };
      const v = JSON.parse(text) as Partial<TelemetrySettings>;
      const signals = Array.isArray(v.signals) ? v.signals.filter((s) => (TELEMETRY_SIGNALS as readonly string[]).includes(s)) : [...TELEMETRY_SIGNALS];
      return telemetryRecord({ on: v.on === true, endpoint: typeof v.endpoint === 'string' ? v.endpoint : '', signals });
    },
    setTelemetry: (s) => write('telemetry', JSON.stringify(telemetryRecord(s))),
  };
}
