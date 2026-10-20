// Issue #2203, part 2: a person sets the critical flag on any job, whatever its priority, so the critical job tracker
// shows it. The daemon, store and HTTP edge are real.
//
// Feature: the critical flag
//   Scenario: a person marks a job critical, and clears the flag
//     Given a job of priority 50 that waits on a question
//     When a person marks it critical
//     Then the job is `critical`, and `job.critical_flag_changed` names who acted
//     When the person clears the flag
//     Then the job is no longer `critical`, and a second event names who acted
//   Scenario: the same flag again changes nothing; an ended job is not marked; an unknown job is 404; no session is 403
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { ADMIN_ID } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

async function start() {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, seams: { levels: [] } });
  const job = await t.pull({ op: 'ask', message: 'go on?' });
  await t.waitForQuestion(job.id, (q) => q.tier === 'human');
  return { app: t, job, session: await t.login() };
}

const flagEvents = (a: TestApp) => a.user(ADMIN_ID).store.events.recent(1000).filter((e) => e.type === 'job.critical_flag_changed');

describe('the critical flag (issue #2203)', () => {
  it('a person marks a job critical whatever its priority, and clears the flag', async () => {
    const { app, job, session } = await start();
    expect(job.priority).toBe(50);

    const marked = await app.ui<Job>(`/ui/api/jobs/${job.id}/critical`, { critical: true }, { token: session });
    expect(marked.status).toBe(200);
    expect(marked.body.critical).toBe(true);
    expect((await app.api<Job>('GET', `/api/jobs/${job.id}`, undefined, { 'x-hopper-session': session })).body.critical).toBe(true);
    expect(flagEvents(app)).toEqual([expect.objectContaining({ jobId: job.id, data: expect.objectContaining({ critical: true, via: 'ui' }) })]);

    const cleared = await app.ui<Job>(`/ui/api/jobs/${job.id}/critical`, { critical: false }, { token: session });
    expect(cleared.status).toBe(200);
    expect(cleared.body.critical).toBeUndefined();
    expect(flagEvents(app).map((e) => e.data)).toEqual(expect.arrayContaining([expect.objectContaining({ critical: false, via: 'ui' })]));
    expect(flagEvents(app)).toHaveLength(2);
  });

  it('the same flag again changes nothing; an ended job is not marked; unknown 404; no session 403; a bad body 400', async () => {
    const { app, job, session } = await start();
    expect((await app.ui(`/ui/api/jobs/${job.id}/critical`, { critical: false }, { token: session })).status).toBe(200);
    expect(flagEvents(app)).toHaveLength(0);
    expect((await app.ui(`/ui/api/jobs/${job.id}/critical`, { critical: 'yes' }, { token: session })).status).toBe(400);
    expect((await app.ui(`/ui/api/jobs/${job.id}/critical`, { critical: true })).status).toBe(403);
    expect((await app.ui('/ui/api/jobs/nope/critical', { critical: true }, { token: session })).status).toBe(404);

    expect((await app.ui(`/ui/api/jobs/${job.id}/cancel`, {}, { token: session })).status).toBe(200);
    expect((await app.ui(`/ui/api/jobs/${job.id}/critical`, { critical: true }, { token: session })).status).toBe(409);
    expect(flagEvents(app)).toHaveLength(0);
  });
});
