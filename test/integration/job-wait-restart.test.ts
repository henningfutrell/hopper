// Issue #1571: the hopper wakes a job on its own wait on the event that settles it, in memory after the event commits. A
// stop between the commit and the wake left the job `waiting_on` for ever. The hopper that starts again wakes it.
// Two app instances over one database and one fake herdr, as herdr-reattach.test.ts.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_ID } from '../../src/domain/types.ts';
import { createFakeHerdrClient, type FakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { databaseUrlFor } from '../support/database.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000, promptSteadyMs: 100 } }];
const item = { executor: 'herdr-claude', prompt: 'Fix the bug', cwd: '/tmp', env: {} };
const DONE = { output: ['● The other job is done. Pushed.', '  HOPPER_DONE'] };

const apps: TestApp[] = [];
let db: { dbPath: string; cleanup(): void } | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  db?.cleanup();
  db = undefined;
});

async function boot(herdr: FakeHerdrClient): Promise<TestApp> {
  const a = await startTestApp({ dbPath: db!.dbPath, plugins: { executors: EXECUTORS, machines: lanes(1) }, seams: { herdr, levels: [] } });
  apps.push(a);
  return a;
}

/** Commit `event` to the admin's store while no hopper runs: nothing is in memory to wake a job on it. */
function commitWhileStopped(event: { type: 'job.finished'; jobId: string; data: { result: Record<string, never> } }): void {
  const instance = openInstanceStore({ url: databaseUrlFor(db!.dbPath), clock: { now: () => new Date() } });
  try {
    const store = instance.userStore({ id: ADMIN_ID });
    try { store.events.append(event); } finally { store.close(); }
  } finally { instance.close(); }
}

describe('a job on its own wait across a stop (issue #1571)', () => {
  it('the event that settles its wait committed while the hopper was stopped: the hopper started again wakes it', async () => {
    db = tempDbPath();
    const other = randomUUID();
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [{ output: ['● The fix needs the other job first.', '  HOPPER_WAITING', '  for: the other job to end', `  on: job ${other}`] }, DONE] });
    const first = await boot(herdr);
    const job = await first.pull({}, item);
    await first.waitForStatus(job.id, 'waiting_on', 8000);
    await first.stop();
    apps.splice(0);

    commitWhileStopped({ type: 'job.finished', jobId: other, data: { result: {} } });

    const second = await boot(herdr);
    await second.waitForStatus(job.id, 'finished', 8000);
    expect(herdr.prompts[1]!.text).toContain(`job ${other} finished`);
    const ended = (await second.events()).find((e) => e.jobId === job.id && e.type === 'job.wait_ended');
    expect(ended!.data).toEqual({ by: 'hopper', note: `job ${other} finished` });
  });
});
