// The daemon's telemetry at start (issue #1486, design.md "Telemetry"): the SDK, on only when the launch's OTEL_*
// variables name an exporter; then each log line also goes out as a log record, and the process's basics are reported.
// Called before the log mask covers the streams: the bridge then gets the masked line.
import type { Writable } from 'node:stream';
import { bridgeLogStream } from './logs.ts';
import { observeProcess } from './process.ts';
import { bridgesToItself, startTelemetry, type Telemetry } from './sdk.ts';

export function startProcessTelemetry(o: { env: Record<string, string | undefined>; version: string; stdout: Writable; stderr: Writable }): Telemetry {
  const telemetry = startTelemetry({ env: o.env, version: o.version });
  if (!telemetry.enabled) return telemetry;
  // Logs exported to the console would come back as lines, and be exported again.
  if (!bridgesToItself(o.env)) { bridgeLogStream(o.stdout, 'info'); bridgeLogStream(o.stderr, 'warn'); }
  const stopProcess = observeProcess();
  return { enabled: true, shutdown: () => { stopProcess(); return telemetry.shutdown(); } };
}
