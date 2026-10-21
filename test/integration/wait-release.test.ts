// Issue #2303: jobs on their own wait kept their agent sessions live, and on a machine short of memory those sessions alone
// held enough memory that the memory floor (issue #2291) admitted no new job, with nothing running. Now a job that waits for
// memory ends the agents of the jobs on their own wait on that machine (a wait the hopper watches); each keeps its wait,
// work tree and agent session, and resumes its session in a new pane when its wait ends. Real daemon over the fake herdr.
import { afterEach, describe, expect, it } from 'vitest';
import type { FailuresView, Job, ResourceReading } from '../../src/domain/types.ts';
import { createFakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { RELEASED_NOTE } from '../../src/executors/herdr/restored.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const GIB = 1024 ** 3;
let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

const WAIT = { output: ['● The step needs a credential.', '  HOPPER_WAITING', '  for: a vault grant for the deploy key', '  on: vault grant'] };
const done = (what: string) => ({ output: [`● ${what}`, '  HOPPER_DONE'] });
const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000, promptSteadyMs: 100 } }];
const item = (what: string) => ({ executor: 'herdr-claude', prompt: what, cwd: '/tmp', env: {} });

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

describe('a wait release (issue #2303)', () => {
  it('a job that waits for memory, with nothing running, ends the agent of a job on its own wait; that job resumes its session when its wait ends', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WAIT, done('Built it.'), done('Deployed.')] });
    const memory = { availableGiB: 9 };
    const db = tempDbPath();
    cleanup = db.cleanup;
    const localResources = (): ResourceReading => ({ cores: 8, memTotalBytes: 14 * GIB, memAvailableBytes: memory.availableGiB * GIB });
    const a = t = await startTestApp({ dbPath: db.dbPath, plugins: { executors: EXECUTORS, machines: lanes(2) }, seams: { herdr, levels: [], localResources } });

    const waiter = await a.pull({}, item('Deploy it'));
    const waiting = await a.waitForStatus(waiter.id, 'waiting_on', 8000);
    const session = waiting.agentSession;
    expect(session).toBeDefined();

    // The waiting session keeps the memory: 2 GiB available, the floor 1.4 GiB, a new job needs 2 GiB.
    memory.availableGiB = 2;
    const builder = await a.pull({}, item('Build it'));
    await waitFor(async () => (await a.events('types=job.wait_released')).length > 0, { what: 'a wait release', timeoutMs: 8000 });
    const [released] = await a.events('types=job.wait_released');
    expect(released!.jobId).toBe(waiter.id);
    expect(released!.machineId).toBe('local');
    const kept: Job = await a.job(waiter.id);
    expect(kept.status).toBe('waiting_on');
    expect(kept.waitReleased?.machineId).toBe('local');
    // Its agent ended, and it is not taken for a stranded wait.
    const paneId = (waiting.executorState as { paneId: string }).paneId;
    await waitFor(() => herdr.closed.includes(paneId), { what: 'the waiting job\'s pane closed' });
    expect((await a.job(waiter.id)).wait?.strandedAt).toBeUndefined();
    // Nothing runs and a job waits for memory: the Failures view says so.
    const view = (await a.api<FailuresView>('GET', '/api/failures')).body;
    expect(view.stuck.find((c) => c.cause === 'memory_starved')).toMatchObject({ ids: [builder.id] });

    // The release freed the memory: the waiting job starts.
    memory.availableGiB = 9;
    await a.waitForStatus(builder.id, 'finished', 8000);

    // Its wait ends: it resumes its own session in a new pane, told why its agent ended.
    const token = await a.login();
    expect((await a.ui(`/ui/api/jobs/${waiter.id}/end-wait`, {}, { token })).status).toBe(200);
    const back = await a.waitForStatus(waiter.id, 'finished', 8000);
    expect(back.agentSession).toBe(session);
    expect(back.waitReleased).toBeUndefined();
    expect(herdr.agentStarts.at(-1)!.args).toEqual(expect.arrayContaining(['--resume', session!]));
    expect(herdr.prompts.at(-1)!.text).toContain(RELEASED_NOTE);
  });
});
