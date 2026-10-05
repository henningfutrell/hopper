// A lane shows running only while it has a running job (issue #181). A lane is held busy from its
// claim until its job's outcome is recorded; a job that ends any other way must not leave its lane
// busy for good. Every decision step frees a lane whose job no longer runs on it.
import { afterEach, describe, expect, it } from 'vitest';
import type { Lane } from '../../src/domain/types.ts';
import type { MachineView } from '../../src/engine/index.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

async function start(): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, plugins: { machines: lanes(2) } });
  return t;
}

const shownLanes = async (a: TestApp): Promise<Lane[]> =>
  (await a.api<{ machines: MachineView[] }>('GET', '/api/machines')).body.machines.flatMap((m) => m.lanes);

/** A lane left holding a job that ended without its outcome freeing the lane. */
async function stranded(a: TestApp, state: Lane['state']): Promise<{ laneId: string; jobId: string }> {
  const job = await a.pull({ op: 'echo', message: 'done' });
  await a.waitForStatus(job.id, 'finished');
  const { store } = a.user();
  const laneId = store.tx(() => {
    const lane = store.lanes.open('local');
    store.lanes.update(lane.id, { state, jobId: job.id, idleSince: undefined });
    return lane.id;
  });
  return { laneId, jobId: job.id };
}

describe('a lane runs only while its job runs', () => {
  it('a busy lane whose job has ended is no longer shown running', async () => {
    const a = await start();
    const { laneId } = await stranded(a, 'busy');
    await waitFor(async () => !(await shownLanes(a)).some((l) => l.id === laneId && l.state !== 'idle'), { what: `${laneId} not running` });
  });

  it('a draining lane whose job has ended closes', async () => {
    const a = await start();
    const { laneId } = await stranded(a, 'draining');
    await waitFor(async () => !(await shownLanes(a)).some((l) => l.id === laneId), { what: `${laneId} closed` });
  });

  it('a lane whose job still runs on it stays running', async () => {
    const a = await start();
    const job = await a.pull({ op: 'sleep', ms: 1500 });
    const running = await a.waitForStatus(job.id, 'running');
    await new Promise((r) => setTimeout(r, 300));
    expect((await shownLanes(a)).find((l) => l.id === running.laneId)).toMatchObject({ state: 'busy', jobId: job.id });
  });
});
