// Issue #2234: Machines shows a machine's unhealthy lanes: which lane, how many starts in a row failed, the last start
// error, and when it takes a job again.
import { describe, expect, it } from 'vitest';
import { unhealthyLaneLines } from '../../ui/src/model/lane-health.ts';

describe('unhealthy lanes on Machines (issue #2234)', () => {
  const base = { id: 'hopper-sandbox-claude', label: 'hopper-sandbox-claude', maxLanes: 1, online: true, executors: [] };
  const now = Date.parse('2026-10-20T13:22:00.000Z');
  const out = {
    laneId: 'hopper-sandbox-claude/lane-1', failures: 3, since: '2026-10-20T13:10:00.000Z', until: '2026-10-20T13:52:00.000Z',
    error: 'claude did not start in 3 attempts: pane w1:p3 never set up the job\'s container runtime within 60000 ms',
  };

  it('each lane out: its name, the failed starts, when it takes a job again, and the last error', () => {
    expect(unhealthyLaneLines({ ...base, unhealthyLanes: [out] }, now)).toEqual([{
      lane: 'lane-1',
      text: '3 starts in a row failed with the same start error; it takes no new job until it is tried again in 30m 0s',
      error: out.error,
    }]);
  });

  it('a lane whose time out passed, or none out: nothing', () => {
    expect(unhealthyLaneLines({ ...base, unhealthyLanes: [{ ...out, until: '2026-10-20T13:22:00.000Z' }] }, now)).toEqual([]);
    expect(unhealthyLaneLines(base, now)).toEqual([]);
  });
});
