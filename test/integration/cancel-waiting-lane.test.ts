// Issue #2676: a job cancelled while it waited (queued or held) kept the lane id of an earlier attempt, though another job
// had that lane by then. A cancel of a job no runner holds clears its lane id and leaves every lane as it was.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

let t: TestApp;
let cleanup: () => void;

beforeEach(async () => {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath });
});
afterEach(async () => {
  await t.stop();
  cleanup();
});

describe('a cancel of a job that waits (issue #2676)', () => {
  it('clears the lane id an earlier attempt left on it, and the lane another job holds stays that job\'s', async () => {
    const { store } = t.user();
    const at = new Date().toISOString();
    // A machine down: the job stays live, and no run takes it.
    store.problems.create({ signature: 'machine down', title: 'Machine down', decision: 'hold', scope: {}, status: 'open', openedAt: at, updatedAt: at, general: false, jobIds: [] });
    const other = await t.pull({ op: 'echo' });
    const job = await t.pull({ op: 'echo' });
    const lane = store.tx(() => {
      const l = store.lanes.open('local');
      store.lanes.update(l.id, { state: 'busy', jobId: other.id });
      store.jobs.update(job.id, { laneId: l.id });
      return l;
    });
    const r = await t.ui<{ status: string; laneId?: string }>(`/ui/api/jobs/${job.id}/cancel`, {}, { token: await t.login() });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('cancelled');
    expect(r.body.laneId).toBeUndefined();
    expect((await t.job(job.id)).laneId).toBeUndefined();
    expect(store.lanes.list().find((l) => l.id === lane.id)).toMatchObject({ state: 'busy', jobId: other.id });
  });
});
