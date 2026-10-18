// The telemetry setting, kept and applied (issue #1486, design.md "Telemetry settings"): read from the instance's settings
// at the start and applied; a change is kept, is `telemetry.changed`, and applies at once, without a restart. While the
// launch's OTEL_* variables name an exporter, the setting is kept but the launch wins.
import type { InstanceEvents, InstanceSettingsRepository } from '../domain/ports.ts';
import { telemetryRecord, type TelemetrySettings, type TelemetrySettingsView } from '../domain/telemetry-settings.ts';
import type { TelemetryControl } from './start.ts';

export interface TelemetrySettingsService {
  view(): TelemetrySettingsView;
  /** Keeps the whole setting and applies it; nothing changed, nothing kept and no event. */
  change(settings: TelemetrySettings, by: string): Promise<TelemetrySettingsView>;
  /** Applies the kept setting: at the daemon's start. */
  start(): Promise<void>;
}

export function createTelemetrySettings(o: {
  settings: Pick<InstanceSettingsRepository, 'getTelemetry' | 'setTelemetry'>;
  events: Pick<InstanceEvents, 'append'>;
  control: TelemetryControl;
  logger: { warn(line: string): void };
}): TelemetrySettingsService {
  const view = (): TelemetrySettingsView => ({
    settings: o.settings.getTelemetry(), source: o.control.fromLaunch ? 'launch' : o.control.enabled ? 'settings' : 'off', exporting: o.control.enabled, protocol: 'http/protobuf',
  });
  // A start that fails (an exporter the SDK refuses) leaves telemetry off: the daemon runs on, and says so once.
  const apply = (s: TelemetrySettings): Promise<void> => o.control.apply(s).catch((e: unknown) => {
    o.logger.warn(`hopper: telemetry not started from its setting (${e instanceof Error ? e.name : 'error'})`);
  });
  return {
    view,
    async change(next, by) {
      const from = o.settings.getTelemetry(), to = telemetryRecord(next);
      if (JSON.stringify(from) !== JSON.stringify(to)) {
        o.settings.setTelemetry(to);
        o.events.append({ type: 'telemetry.changed', data: { from, to, by } });
        await apply(to);
      }
      return view();
    },
    start: () => apply(o.settings.getTelemetry()),
  };
}
