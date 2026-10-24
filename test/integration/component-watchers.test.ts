// Issue #1077: component watchers. The daemon, store and HTTP edge are real. Each user has the ledger-vs-GitHub and the
// default-branch-vs-checks watchers and the watchers of its own records (ledger vs jobs, lanes vs jobs, intake vs jobs),
// which check at start; the oldest user also has the stack-health watcher, the instance's. Whether a drift files a drift
// issue is the user's setting, an admin's, in the database.
//
// Feature: component watchers
//   Scenario: the watchers and the setting
//     Given a fresh hopper with no GitHub connection
//     Then GET /api/component-watchers lists the six watchers: the two GitHub checks failed with why, the store's three checked with no drift, the stack's checked, and filing is off
//     When an admin turns filing on
//     Then it is saved, component_watchers.settings_changed is in the log once, and a restart keeps it
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_ID, type DomainEvent } from '../../src/domain/types.ts';
import type { ComponentWatchersView } from '../../src/component-watchers/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
});

const eventsOf = (a: TestApp, type: string): DomainEvent[] => a.user(ADMIN_ID).store.events.recent(1000).filter((e) => e.type === type);
const view = async (a: TestApp) => (await a.api<ComponentWatchersView>('GET', '/api/component-watchers')).body;

describe('component watchers', () => {
  it('lists the ledger-vs-GitHub, ledger-vs-jobs, lanes-vs-jobs, intake-vs-jobs, cleanup-vs-jobs, default-branch-vs-checks and stack-health watchers and keeps the admin\'s setting to file drift issues', { timeout: 40_000 }, async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const app = await startTestApp({ dbPath: db.dbPath });
    apps.push(app);
    const token = await app.login();

    await expect.poll(async () => (await view(app)).watchers[0]?.error, { timeout: 10_000 }).toMatch(/not connected/);
    const v = await view(app);
    expect(v.settings).toEqual({ fileIssues: false });
    expect(v.watchers).toMatchObject([
      { name: 'ledger-github', component: 'the work-item ledger', truth: 'GitHub', intervalSeconds: 900, drifts: [] },
      { name: 'ledger-jobs', component: 'the work-item ledger', truth: 'the job records', intervalSeconds: 300, drifts: [] },
      { name: 'lanes-jobs', component: 'the lanes', truth: 'the job records', intervalSeconds: 300, drifts: [] },
      { name: 'intake-jobs', component: 'intake', truth: 'the job records and the sync timers', intervalSeconds: 300, drifts: [] },
      { name: 'cleanup-jobs', component: 'the resource ledger', truth: 'the job records', intervalSeconds: 300, drifts: [] },
      { name: 'branch-checks', component: 'the job repositories\' default branches', truth: 'their checks on GitHub', intervalSeconds: 900, drifts: [] },
      { name: 'stack-health', component: 'the hopper\'s stack', truth: 'a healthy stack', intervalSeconds: 300, instance: true, drifts: [] },
    ]);
    await expect.poll(async () => (await view(app)).watchers[5]?.error, { timeout: 10_000 }).toMatch(/not connected/);
    // The store's own watchers need no GitHub connection: they checked, and a fresh hopper has no drift.
    await expect.poll(async () => (await view(app)).watchers.filter((w) => !['ledger-github', 'branch-checks'].includes(w.name)).map((w) => [w.checkedAt !== undefined, w.error]), { timeout: 10_000 }).toEqual([[true, undefined], [true, undefined], [true, undefined], [true, undefined], [true, undefined]]);

    const r = await app.ui<ComponentWatchersView>('/ui/api/component-watchers', { fileIssues: true }, { token });
    expect(r.status).toBe(200);
    expect(r.body.settings).toEqual({ fileIssues: true });
    await app.ui('/ui/api/component-watchers', { fileIssues: true }, { token });
    expect(eventsOf(app, 'component_watchers.settings_changed').map((e) => e.data)).toEqual([{ from: { fileIssues: false }, to: { fileIssues: true }, by: expect.any(String) }]);
    expect((await app.ui('/ui/api/component-watchers', { fileIssues: 'yes' }, { token })).status).toBe(400);

    await app.stop();
    apps.splice(0);
    const again = await startTestApp({ dbPath: db.dbPath });
    apps.push(again);
    expect((await view(again)).settings).toEqual({ fileIssues: true });
  });
});
