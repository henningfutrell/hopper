// Telemetry in Settings (issue #1486, design.md "Telemetry settings"): the hopper's admin turns the OTLP export on and off
// in the UI or with an API token, never in a file; it applies at once, is kept across a restart, and a change is an
// event. The real daemon, the real database and a stand-in collector on loopback; no timing asserted.
//   Scenario: off by default; the admin turns it on, the daemon's spans reach the collector, a bad endpoint is 400
//   Scenario: kept across a restart and applied at the start; turned off, the export stops
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { TelemetrySettingsView } from '../../src/domain/telemetry-settings.ts';
import { startProcessTelemetry, type ProcessTelemetry } from '../../src/telemetry/start.ts';
import { telemetrySummary } from '../../src/telemetry/summary.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

let t: TestApp | undefined;
let telemetry: ProcessTelemetry | undefined;
let server: Server | undefined;
const cleanups: (() => void)[] = [];

afterEach(async () => {
  await t?.stop();
  t = undefined;
  await telemetry?.shutdown();
  telemetry = undefined;
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = undefined;
  for (const c of cleanups.splice(0)) c();
  telemetrySummary.reset();
});

async function collector(): Promise<{ url: string; paths: string[] }> {
  const paths: string[] = [];
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => { paths.push(req.url ?? ''); res.writeHead(200).end(); });
  });
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, paths };
}

async function boot(dbPath: string): Promise<TestApp> {
  telemetry = startProcessTelemetry({ env: {}, version: '0.0.0-test', stdout: new PassThrough(), stderr: new PassThrough() });
  t = await startTestApp({ dbPath, seams: { telemetry } });
  return t;
}

const view = async (a: TestApp, token: string): Promise<TelemetrySettingsView> =>
  (await a.api('GET', '/api/telemetry-settings', undefined, { 'x-hopper-session': token })).body as TelemetrySettingsView;

describe('telemetry in Settings (issue #1486)', () => {
  it('is off by default; turned on it exports the daemon\'s spans at once; a change is an event; a bad endpoint is 400', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const { url, paths } = await collector();
    const a = await boot(db.dbPath);
    const token = await a.login();
    expect(await view(a, token)).toEqual({ settings: { on: false, endpoint: '', signals: ['traces', 'metrics', 'logs'] }, source: 'off', exporting: false, protocol: 'http/protobuf' });

    const r = await a.ui<TelemetrySettingsView>('/ui/api/telemetry-settings', { on: true, endpoint: `${url}/`, signals: ['traces'] }, { token });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ settings: { on: true, endpoint: url, signals: ['traces'] }, source: 'settings', exporting: true, protocol: 'http/protobuf' });
    expect((await a.events('types=telemetry.changed')).map((e) => e.data)).toEqual([
      { from: { on: false, endpoint: '', signals: ['traces', 'metrics', 'logs'] }, to: { on: true, endpoint: url, signals: ['traces'] }, by: expect.any(String) },
    ]);
    await view(a, token); // a request: a span

    for (const bad of [{ on: true, endpoint: '', signals: ['traces'] }, { on: true, endpoint: 'http://u:p@collector', signals: ['traces'] }, { on: true, endpoint: url, signals: ['spans'] }]) {
      expect((await a.ui('/ui/api/telemetry-settings', bad, { token })).status, JSON.stringify(bad)).toBe(400);
    }
    const off = await a.ui<TelemetrySettingsView>('/ui/api/telemetry-settings', { on: false, endpoint: url, signals: ['traces'] }, { token });
    expect(off.body).toMatchObject({ source: 'off', exporting: false });
    expect(paths).toContain('/v1/traces');
    expect(paths.every((p) => p === '/v1/traces')).toBe(true);
  });

  it('is kept across a restart and applied at the start', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const { url } = await collector();
    let a = await boot(db.dbPath);
    let token = await a.login();
    await a.ui('/ui/api/telemetry-settings', { on: true, endpoint: url, signals: ['metrics'] }, { token });
    await a.stop();
    t = undefined;
    await telemetry!.shutdown();

    a = await boot(db.dbPath);
    token = await a.login();
    await expect.poll(async () => (await view(a, token)).exporting).toBe(true);
    expect(await view(a, token)).toMatchObject({ settings: { on: true, endpoint: url, signals: ['metrics'] }, source: 'settings' });
    expect(telemetry!.enabled).toBe(true);
  });
});
