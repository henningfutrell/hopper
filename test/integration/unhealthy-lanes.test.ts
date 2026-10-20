// Issue #2234 through the real daemon: a lane whose starts fail again and again with the same start error is unhealthy.
// Its machine says so on GET /api/machines, a lane.unhealthy event records it, and no new job starts there meanwhile.
import { afterEach, describe, expect, it } from 'vitest';
import type { MachineSnapshot } from '../../src/domain/types.ts';
import { LANE_START_FAILURES } from '../../src/engine/lane-health.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

const START = 'herdr: agent did not start: pane never set up the job\'s container runtime';

describe('an unhealthy lane through the daemon (issue #2234)', () => {
  it(`after ${LANE_START_FAILURES} starts in a row fail the same way: the machine says so, an event records it, and the next job waits`, async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    const a = await startTestApp({ dbPath: db.dbPath, plugins: { machines: lanes(1) } });
    apps.push(a);
    for (let i = 0; i < LANE_START_FAILURES; i++) {
      const job = await a.pull({ op: 'fail', message: START });
      await a.waitForStatus(job.id, 'failed');
    }
    const machine = await waitFor(async () => (await a.api<{ machines: MachineSnapshot[] }>('GET', '/api/machines')).body.machines.find((m) => m.unhealthyLanes?.length));
    expect(machine.unhealthyLanes).toEqual([expect.objectContaining({ laneId: `${machine.id}/lane-1`, failures: LANE_START_FAILURES, error: START })]);
    const events = await a.events('types=lane.unhealthy');
    expect(events).toEqual([expect.objectContaining({ laneId: `${machine.id}/lane-1`, machineId: machine.id, data: expect.objectContaining({ failures: LANE_START_FAILURES }) })]);
    const next = await a.pull({ op: 'echo' });
    const waiting = await waitFor(async () => { const j = await a.job(next.id); return j.waitReason ? j : undefined; });
    expect(waiting.status).toBe('queued');
  });
});
