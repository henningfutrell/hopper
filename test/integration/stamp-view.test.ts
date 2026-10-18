// Issue #655, part 10: the API and CLI view of a job's trust stamp, through the real daemon, store, HTTP edge and CLI.
//
// Feature: the stamp view
//   Scenario: a job a stricter brake holds
//     Given the manual source set to strict
//     When a job of it (stamped approved) is pulled
//     Then GET /api/jobs/:id/stamp says its stamp verifies at approved, the brake needs trusted, and why it is held
//     And `hopper job stamp <id>` says the same, by its full or its short id
//   Scenario: a quarantined job
//     When a person quarantines it
//     Then the view says quarantined, the level it had, gate 2 asks a person, and its doors are closed
//   Scenario: no such job: 404
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import type { StampView } from '../../src/domain/stamp-view.ts';
import { databaseUrlFor } from '../support/database.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

async function boot(): Promise<TestApp> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const a = await startTestApp({ dbPath: db.dbPath });
  apps.push(a);
  return a;
}

async function hopper(a: TestApp, argv: string[]) {
  const out: string[] = [];
  const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(a.dbPath) }, stdin: () => '', out: (x) => out.push(x), err: () => {} };
  const code = await runCli([...argv, '--url', a.url], io);
  return { code, json: code === 0 ? JSON.parse(out.join('')) as unknown : undefined };
}

describe('the stamp view (issue #655, part 10)', () => {
  it('says what holds a job, through the API and the CLI', async () => {
    const a = await boot();
    const token = await a.login();
    await a.ui('/ui/api/intake-strictness', { default: 'standard', sources: { manual: 'strict' }, repos: {} }, { token });
    const j = await a.pull({ op: 'echo' });
    const held = await a.waitForStatus(j.id, 'held');
    const view = await a.api('GET', `/api/jobs/${j.id}/stamp`);
    expect(view.status).toBe(200);
    expect(view.body).toEqual({
      jobId: j.id,
      stamp: { level: 'approved', reasons: held.stamp!.reasons, by: 'intake', at: held.stamp!.at },
      verifies: 'yes', level: 'approved',
      brake: { strictness: 'strict', needs: 'trusted', at: { source: 'manual' } },
      startHold: held.holdReason, gate2: 'person', doorsOpen: true, checkDue: true, originActs: null, visibility: null, linkedPulls: null,
    });
    expect((await hopper(a, ['job', 'stamp', j.id])).json).toEqual(view.body);
    expect((await hopper(a, ['job', 'stamp', j.id.slice(0, 8), '--json'])).json).toEqual(view.body);
  });

  it('a quarantined job: gate 2 asks a person, and its doors are closed', async () => {
    const a = await boot();
    const token = await a.login();
    await a.ui('/ui/api/intake-strictness', { default: 'standard', sources: { manual: 'strict' }, repos: {} }, { token });
    const j = await a.pull({ op: 'echo' });
    await a.waitForStatus(j.id, 'held');
    expect((await a.ui(`/ui/api/jobs/${j.id}/quarantine`, {}, { token })).status).toBe(200);
    expect((await a.api<StampView>('GET', `/api/jobs/${j.id}/stamp`)).body).toMatchObject({
      verifies: 'yes', level: 'quarantined', stamp: { level: 'quarantined', was: 'approved', by: 'person' }, gate2: 'person', doorsOpen: false,
    });
  });

  it('no such job: 404', async () => {
    const a = await boot();
    expect((await a.api('GET', '/api/jobs/nope/stamp')).status).toBe(404);
    expect((await hopper(a, ['job', 'stamp', 'ffffffff'])).code).toBe(2);
  });
});
