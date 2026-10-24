// Issue #2738: the update swap loads the hopper's client release while jobs are at work on a client target, but only when
// each of them rides the client's restart: its agent runs in a herdr pane (herdr's own unit, which the restart leaves), it
// started there, and its executor watches it again once the link is back (issue #752). A print-mode turn runs in the
// client's own process, and a job still starting sends calls a dropped link fails: neither rides it.
import { describe, expect, it } from 'vitest';
import type { Executor } from '../../src/domain/ports.ts';
import type { Job } from '../../src/domain/types.ts';
import { ridesClientRestart } from '../../src/machines/client-release.ts';

const herdr = { name: 'claude', reattach: () => Promise.resolve({ kind: 'done' }), canReattach: () => Promise.resolve(true) } as unknown as Executor;
const printMode = { name: 'opencode' } as unknown as Executor;
const job = (o: Partial<Job> = {}): Job => ({ id: 'a', status: 'running', spec: { executor: 'claude' }, executorState: { paneId: 'p1', agentName: 'hopper-a' }, agentSession: 's1', ...o }) as unknown as Job;

describe('which jobs ride a client restart', () => {
  it('a running job whose agent started in its pane, on an executor that reattaches, rides it', () => {
    expect(ridesClientRestart(job(), herdr)).toBe(true);
  });

  it('a job still starting (no agent session yet) does not', () => {
    expect(ridesClientRestart(job({ agentSession: undefined }), herdr)).toBe(false);
    expect(ridesClientRestart(job({ executorState: undefined }), herdr)).toBe(false);
  });

  it('a print-mode turn, an unknown executor or a job held on a lost link does not', () => {
    expect(ridesClientRestart(job(), printMode)).toBe(false);
    expect(ridesClientRestart(job(), undefined)).toBe(false);
    expect(ridesClientRestart(job({ linkLost: { machine: 'm', since: 'x', failsAt: 'y' } }), herdr)).toBe(false);
    expect(ridesClientRestart(undefined, herdr)).toBe(false);
  });
});
