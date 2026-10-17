// Issue #655 part 3: intake strictness (brake 1), through the real daemon, store and HTTP edge.
//
// Feature: intake strictness
//   Scenario: an admin's setting, standard by default
//     Then GET /api/intake-strictness says standard, with no source or repository set
//     And only an admin changes it; a repository is kept lowercased; a bad value is 400; a change is recorded with who
//   Scenario: a stricter brake holds a job its stamp no longer lets through, and a looser one lets it run
//     Given the manual source set to strict
//     When a job of it (stamped approved) is pulled
//     Then it is held, and the hold names the brake
//     When an admin sets the source back to standard
//     Then the job runs, with no restart
import { afterEach, describe, expect, it } from 'vitest';
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

describe('intake strictness (issue #655, brake 1)', () => {
  it('is an admin\'s setting, standard by default; a change is recorded', async () => {
    const a = await boot();
    expect((await a.api('GET', '/api/intake-strictness')).body).toEqual({ default: 'standard', sources: {}, repos: {} });
    expect((await a.ui('/ui/api/intake-strictness', { default: 'strict', sources: {}, repos: {} })).status).toBe(403);
    const token = await a.login();
    expect((await a.ui('/ui/api/intake-strictness', { default: 'loose', sources: {}, repos: {} }, { token })).status).toBe(400);
    expect((await a.ui('/ui/api/intake-strictness', { default: 'standard', sources: {}, repos: { 'not a repo': 'strict' } }, { token })).status).toBe(400);
    expect(await a.ui('/ui/api/intake-strictness', { default: 'standard', sources: { manual: 'open' }, repos: { 'Octo/Tools': 'closed' } }, { token }))
      .toMatchObject({ status: 200, body: { default: 'standard', sources: { manual: 'open' }, repos: { 'octo/tools': 'closed' } } });
    await a.ui('/ui/api/intake-strictness', { default: 'standard', sources: { manual: 'open' }, repos: { 'octo/tools': 'closed' } }, { token });
    expect((await a.events('types=intake.strictness_changed')).map((e) => e.data)).toEqual([
      expect.objectContaining({ from: { default: 'standard', sources: {}, repos: {} }, to: { default: 'standard', sources: { manual: 'open' }, repos: { 'octo/tools': 'closed' } } }),
    ]);
  });

  it('a stricter brake holds a job; a looser one lets it run, with no restart', async () => {
    const a = await boot();
    const token = await a.login();
    await a.ui('/ui/api/intake-strictness', { default: 'standard', sources: { manual: 'strict' }, repos: {} }, { token });
    const j = await a.pull({ op: 'echo' });
    const held = await a.waitForStatus(j.id, 'held');
    expect(held.stamp?.level).toBe('approved');
    expect(held.holdReason).toBe('trust stamp approved is below trusted (intake strictness strict for the source manual): held — an admin changes the intake strictness in Settings → Intake, or a person cancels it');
    await a.ui('/ui/api/intake-strictness', { default: 'standard', sources: { manual: 'standard' }, repos: {} }, { token });
    await a.waitForStatus(j.id, 'done');
  });
});
