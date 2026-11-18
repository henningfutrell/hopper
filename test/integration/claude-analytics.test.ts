// The `claude-analytics` usage source in a running hopper (issue #2966): the user's runtime gives it the user's analytics
// key, opened from the system secret `claude-analytics-key`, and the Claude accounts the other usage sources read. With
// no key it is not configured, a state and not a problem, and its usage is never unknown: the machine keeps its lanes.
// Against a fake Analytics API on loopback; never a real URL.
import { afterEach, describe, expect, it } from 'vitest';
import type { UsageReport } from '../../src/domain/types.ts';
import { NOT_CONFIGURED } from '../../src/plugins/usage-source/claude-analytics/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
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
});
