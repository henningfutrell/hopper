// The telemetry setting, applied (issue #1486, design.md "Telemetry settings"): with no OTEL_* exporter at launch, the
// setting turns the export on and off at once, without a restart, to its OTLP endpoint over HTTP and protobuf, for the
// signals it names; the launch's own headers still go with it. When the launch names an exporter, the launch wins.
// Behaviour only: a stand-in collector on loopback, no timing asserted.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tracer } from '../../src/telemetry/instruments.ts';
import { startProcessTelemetry, type ProcessTelemetry } from '../../src/telemetry/start.ts';
import { telemetrySummary } from '../../src/telemetry/summary.ts';

interface Received { path: string; type: string; auth: string | undefined }

let server: Server | undefined;
let telemetry: ProcessTelemetry | undefined;

afterEach(async () => {
  await telemetry?.shutdown();
  telemetry = undefined;
  vi.unstubAllEnvs();
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = undefined;
  telemetrySummary.reset();
});

async function collector(): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      received.push({ path: req.url ?? '', type: String(req.headers['content-type']), auth: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'application/x-protobuf' }).end();
    });
  });
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, received };
}

const start = (env: Record<string, string> = {}): ProcessTelemetry =>
  (telemetry = startProcessTelemetry({ env, version: '0.0.0-test', stdout: new PassThrough(), stderr: new PassThrough() }));

describe('the telemetry setting, applied (issue #1486)', () => {
  it('with no exporter at launch it is off until the setting turns it on, then exports to its endpoint, and off again flushes and stops', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_HEADERS', 'authorization=Bearer collector-key');
    const { url, received } = await collector();
    const t = start();
    expect(t).toMatchObject({ enabled: false, fromLaunch: false });

    await t.apply({ on: true, endpoint: url, signals: ['traces', 'metrics', 'logs'] });
    expect(t.enabled).toBe(true);
    expect(telemetrySummary.read().exporting).toBe(true);
    tracer().startSpan('hopper.test.span').end();

    await t.apply({ on: false, endpoint: url, signals: ['traces', 'metrics', 'logs'] });
    expect(t.enabled).toBe(false);
    expect(telemetrySummary.read().exporting).toBe(false);
    const traces = received.filter((r) => r.path === '/v1/traces');
    expect(traces.length).toBeGreaterThan(0);
    expect(traces[0]).toMatchObject({ type: 'application/x-protobuf', auth: 'Bearer collector-key' });
    expect(received.some((r) => r.path === '/v1/metrics')).toBe(true);

    const before = received.length;
    tracer().startSpan('hopper.test.after').end();
    await t.shutdown();
    expect(received.length).toBe(before);
  });

  it('exports only the signals the setting names, under the endpoint\'s own path', async () => {
    const { url, received } = await collector();
    const t = start();
    await t.apply({ on: true, endpoint: `${url}/otlp`, signals: ['traces'] });
    tracer().startSpan('hopper.test.span').end();
    await t.apply({ on: true, endpoint: `${url}/otlp`, signals: ['metrics'] });
    expect(t.enabled).toBe(true);
    await t.shutdown();
    expect(received.filter((r) => r.path === '/otlp/v1/traces').length).toBeGreaterThan(0);
    expect(received.filter((r) => r.path === '/otlp/v1/metrics').length).toBeGreaterThan(0);
    expect(received.every((r) => ['/otlp/v1/traces', '/otlp/v1/metrics'].includes(r.path))).toBe(true);
  });

  it('when the launch names an exporter, the launch wins and the setting changes nothing', async () => {
    const { url, received } = await collector();
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', url);
    const t = start({ OTEL_EXPORTER_OTLP_ENDPOINT: url });
    expect(t).toMatchObject({ enabled: true, fromLaunch: true });
    await t.apply({ on: false, endpoint: '', signals: [] });
    expect(t.enabled).toBe(true);
    tracer().startSpan('hopper.test.span').end();
    await t.shutdown();
    expect(received.some((r) => r.path === '/v1/traces')).toBe(true);
  });
});
