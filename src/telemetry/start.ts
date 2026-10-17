// The daemon's telemetry (issue #1486, design.md "Telemetry", "Telemetry settings"): the SDK, on when the launch's OTEL_*
// variables name an exporter — then the launch wins for good —, else when the telemetry setting turns it on, applied at
// once: the SDK running is stopped (what it holds is flushed) and one is started from the setting. While it runs, each log
// line also goes out as a log record, and the process's basics and what runs now (live.ts) are reported.
// Called before the log mask covers the streams: the bridge then gets the masked line.
import type { Writable } from 'node:stream';
import type { TelemetrySettings } from '../domain/telemetry-settings.ts';
import { observeLive } from './live.ts';
import { bridgeLogStream } from './logs.ts';
import { observeProcess } from './process.ts';
import { bridgesToItself, startTelemetry, telemetryWanted, type Telemetry } from './sdk.ts';
import { telemetrySummary } from './summary.ts';

/** The daemon's telemetry, as the parts that apply the setting see it. */
export interface TelemetryControl {
  /** True while the hopper exports. */
  readonly enabled: boolean;
  /** True when the launch's OTEL_* variables configure it: the setting then changes nothing. */
  readonly fromLaunch: boolean;
  /** Applies the setting: stops the export from the setting before, and starts one when it is on. In order, one at a time. */
  apply(settings: TelemetrySettings): Promise<void>;
}

export interface ProcessTelemetry extends TelemetryControl { shutdown(): Promise<void> }

/** Telemetry nobody configures (a test daemon that names none): off, and the setting is only kept. */
export const NO_TELEMETRY: TelemetryControl = { enabled: false, fromLaunch: false, apply: async () => {} };

const OFF: Telemetry = { enabled: false, shutdown: async () => {} };

export function startProcessTelemetry(o: { env: Record<string, string | undefined>; version: string; stdout: Writable; stderr: Writable }): ProcessTelemetry {
  let bridged = false;
  // The bridge stays once made: with the SDK stopped, a record goes to the API's no-op logger.
  const begin = (t: Telemetry): Telemetry => {
    if (!t.enabled) return t;
    telemetrySummary.exporting(true);
    // Logs exported to the console would come back as lines, and be exported again.
    if (!bridged && !bridgesToItself(o.env)) { bridgeLogStream(o.stdout, 'info'); bridgeLogStream(o.stderr, 'warn'); bridged = true; }
    const stopProcess = observeProcess(), stopLive = observeLive();
    // The gauges stop after the SDK's last flush, so it still reports them.
    return { enabled: true, shutdown: () => { telemetrySummary.exporting(false); return t.shutdown().finally(() => { stopProcess(); stopLive(); }); } };
  };
  const fromLaunch = telemetryWanted(o.env);
  let current = fromLaunch ? begin(startTelemetry({ env: o.env, version: o.version })) : OFF;
  let queue = Promise.resolve();
  const next = (step: () => Promise<void>): Promise<void> => (queue = queue.then(step, step));
  return {
    get enabled() { return current.enabled; },
    fromLaunch,
    apply(settings) {
      if (fromLaunch) return queue;
      return next(async () => {
        const before = current;
        current = OFF;
        await before.shutdown();
        if (settings.on) current = begin(startTelemetry({ env: o.env, version: o.version, otlp: { endpoint: settings.endpoint, signals: settings.signals } }));
      });
    },
    shutdown() {
      return next(async () => { const before = current; current = OFF; await before.shutdown(); });
    },
  };
}
