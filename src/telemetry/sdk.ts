// OpenTelemetry for the hopper (issue #1486, design.md "Telemetry"): the OpenTelemetry Node SDK, started once per process
// from the launch's usual OTEL_* variables — the exporters, the OTLP endpoint and protocol, the sampler, the resource. Off
// unless the launch names an exporter: then the OpenTelemetry API stays its no-op, and every span, metric and log record
// the hopper makes costs next to nothing and goes nowhere. Nothing outside the stack is needed either way.
import { context, metrics, propagation, trace } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { defaultResource, envDetector, resourceFromAttributes } from '@opentelemetry/resources';
import type { LogRecordProcessor } from '@opentelemetry/sdk-logs';
import type { IMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';

type Env = Record<string, string | undefined>;

const SIGNALS = ['TRACES', 'METRICS', 'LOGS'] as const;

/**
 * Whether the launch asks for telemetry: an OTLP endpoint (for all signals or one), or an exporter named for a signal
 * other than `none`; never with OTEL_SDK_DISABLED=true. The SDK alone would default every signal to OTLP on localhost,
 * which a hopper with no collector beside it must not try.
 */
export function telemetryWanted(env: Env): boolean {
  if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === 'true') return false;
  if (env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()) return true;
  for (const s of SIGNALS) {
    if (env[`OTEL_EXPORTER_OTLP_${s}_ENDPOINT`]?.trim()) return true;
    const named = (env[`OTEL_${s}_EXPORTER`] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    if (named.some((x) => x !== 'none')) return true;
  }
  return false;
}

/** Logs exported to the console come back as log lines: bridged, each record would be logged again, without end. */
export function bridgesToItself(env: Env): boolean {
  return (env.OTEL_LOGS_EXPORTER ?? '').split(',').some((x) => x.trim() === 'console');
}

export interface Telemetry {
  /** True when the SDK runs: what the hopper records is exported. */
  enabled: boolean;
  /** Flushes what is pending and puts the API back to its no-op. */
  shutdown(): Promise<void>;
}

export interface TelemetryOptions {
  env: Env;
  /** The hopper's version: the resource's `service.version`. */
  version: string;
  /** Tests: where spans, metrics and log records go, in place of the exporters the environment names. */
  spanProcessors?: SpanProcessor[];
  metricReaders?: IMetricReader[];
  logRecordProcessors?: LogRecordProcessor[];
}

/**
 * Starts the SDK when the launch asks for it (or a test gives its own processors). The resource is `service.name`
 * `hopper` and the version, then OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES; no host or process detector, so no
 * host name, user or command line goes out unless the launch adds it.
 */
export function startTelemetry(o: TelemetryOptions): Telemetry {
  const own = o.spanProcessors !== undefined || o.metricReaders !== undefined || o.logRecordProcessors !== undefined;
  if (!own && !telemetryWanted(o.env)) return { enabled: false, shutdown: async () => {} };
  const sdk = new NodeSDK({
    resource: defaultResource().merge(resourceFromAttributes({ 'service.name': 'hopper', 'service.version': o.version })),
    resourceDetectors: [envDetector],
    ...(o.spanProcessors ? { spanProcessors: o.spanProcessors } : {}),
    ...(o.metricReaders ? { metricReaders: o.metricReaders } : {}),
    ...(o.logRecordProcessors ? { logRecordProcessors: o.logRecordProcessors } : {}),
  });
  sdk.start();
  let stopped: Promise<void> | undefined;
  return {
    enabled: true,
    shutdown() {
      stopped ??= sdk.shutdown().finally(() => {
        trace.disable(); metrics.disable(); logs.disable(); propagation.disable(); context.disable();
      });
      return stopped;
    },
  };
}
