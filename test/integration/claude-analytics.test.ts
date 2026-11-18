// The `claude-analytics` usage source in a running hopper (issue #2966): the user's runtime gives it the user's analytics
// key, opened from the system secret `claude-analytics-key`, and the Claude accounts the other usage sources read. With
// no key it is not configured, a state and not a problem, and its usage is never unknown: the machine keeps its lanes.
// Against a fake Analytics API on loopback; never a real URL.
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import type { DailyUsageTrend, UsageReport } from '../../src/domain/types.ts';
import { NOT_CONFIGURED } from '../../src/plugins/usage-source/claude-analytics/index.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { databaseUrlFor } from '../support/database.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { KEY } from '../support/webhooks.ts';
import { waitFor } from '../support/wait.ts';
import { fakeUser, startFakeAnalytics, type FakeAnalytics } from '../plugins/fake-claude-analytics.ts';

let t: TestApp | undefined;
let api: FakeAnalytics | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await t?.stop();
  t = undefined;
  await api?.close();
  api = undefined;
  cleanup?.();
});

describe('claude-analytics in a running hopper (issue #2966)', () => {
  it('with no analytics key set: not configured, no call to the API, and no machine in the unknown band', async () => {
    api = await startFakeAnalytics();
    api.users = [fakeUser('user_a', 'dev.a@example.com')];
    const db = tempDbPath();
    cleanup = db.cleanup;
    const printed = { readings: [{ used: 10, limit: 100, unit: '%', window: 'session' }], account: { service: 'claude', identity: 'dev.a@example.com', detail: { plan: 'enterprise' } } };
    const command = [process.execPath, '-e', `console.log(${JSON.stringify(JSON.stringify(printed))})`];
    t = await startTestApp({ dbPath: db.dbPath, plugins: { usageSources: [
      { name: 'plan', plugin: 'command-usage', options: { command, intervalSeconds: 60 } },
      { name: 'analytics', plugin: 'claude-analytics', options: { baseUrl: api.url } },
    ] } });
    const a = t;
    const report = await waitFor(async () => {
      const r = (await a.api('GET', '/api/usage')).body as UsageReport;
      const s = r.sources.find((x) => x.name === 'analytics');
      return s?.notConfigured ? r : undefined;
    }, { what: 'the analytics source not configured' });
    expect(report.sources.find((x) => x.name === 'analytics')).toEqual({ name: 'analytics', notConfigured: NOT_CONFIGURED, informational: true });
    expect(report.machines.map((m) => m.band)).not.toContain('unknown');
    expect(api.seen).toEqual([]);
  });

  it('keeps each day it read for the trend: GET /api/usage/daily and hopper usage analytics answer the matched account\'s days, never another user\'s', async () => {
    api = await startFakeAnalytics();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    api.newestDay = yesterday;
    api.users = [fakeUser('user_a', 'dev.a@example.com'), fakeUser('user_other', 'someone.else@example.com', { cents: '7777.000000' })];
    const db = tempDbPath();
    cleanup = db.cleanup;
    const printed = { readings: [{ used: 10, limit: 100, unit: '%', window: 'session' }], account: { service: 'claude', identity: 'dev.a@example.com', detail: { plan: 'enterprise' } } };
    const command = [process.execPath, '-e', `console.log(${JSON.stringify(JSON.stringify(printed))})`];
    t = await startTestApp({
      dbPath: db.dbPath, seams: { authorizationServer: createFakeAuthorizationServer() }, secrets: { HOPPER_MASTER_KEY: KEY },
      plugins: { usageSources: [
        { name: 'plan', plugin: 'command-usage', options: { command, intervalSeconds: 60 } },
        { name: 'analytics', plugin: 'claude-analytics', options: { baseUrl: api.url } },
      ] },
    });
    const a = t;
    const session = await a.login();
    expect((await a.ui('/ui/api/claude-analytics-key', { action: 'set', value: api.key }, { token: session })).status).toBe(200);
    const trend = await waitFor(async () => {
      const r = (await a.api<DailyUsageTrend>('GET', '/api/usage/daily?days=7')).body;
      return r.daily?.length ? r : undefined;
    }, { what: 'the day kept', timeoutMs: 60_000 });
    expect(trend.days).toBe(7);
    expect(trend.to).toBe(yesterday);
    expect(trend.daily).toEqual([expect.objectContaining({ account: 'dev.a@example.com', date: yesterday, sessions: 5 })]);
    expect(JSON.stringify(trend)).not.toMatch(/someone\.else|user_other|user_a|7777|Name of/);
    expect((await a.api('GET', '/api/usage/daily?days=0')).status).toBe(400);
    expect((await a.api('GET', '/api/usage/daily?days=91')).status).toBe(400);
    const out: string[] = [];
    const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(a.dbPath) }, stdin: () => '', out: (x) => out.push(x), err: () => {} };
    expect(await runCli(['usage', 'analytics', '--days', '7', '--url', a.url], io)).toBe(0);
    expect(JSON.parse(out.join(''))).toEqual(trend);
  });
});
