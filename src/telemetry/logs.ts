// The log bridge (issue #1486, design.md "Telemetry"): the hopper logs by writing lines to stdout and stderr, whoever
// writes them; each write also goes out as an OpenTelemetry log record, with the trace and span it was written in. The
// stream is bridged before the log mask covers it (main.ts), so the bridge gets the masked line: the mask's guarantee
// (issue #685) holds for the exported records too. Off, the API's logger is its no-op.
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import type { Writable } from 'node:stream';
import { SCOPE } from './instruments.ts';

export type LogSeverity = 'info' | 'warn';

const SEVERITY = { info: SeverityNumber.INFO, warn: SeverityNumber.WARN } as const;

/** Every write to `stream` from now on is also a log record of `severity`; the stream still gets it as it was. */
export function bridgeLogStream(stream: Writable, severity: LogSeverity): void {
  const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
  stream.write = ((chunk: unknown, ...rest: unknown[]) => {
    const text = typeof chunk === 'string' ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : undefined;
    const body = text?.replace(/\r?\n$/, '');
    if (body) {
      try {
        logs.getLogger(SCOPE).emit({ severityNumber: SEVERITY[severity], severityText: severity.toUpperCase(), body });
      } catch { /* a log record never stops the line */ }
    }
    return write(chunk, ...rest);
  }) as Writable['write'];
}
