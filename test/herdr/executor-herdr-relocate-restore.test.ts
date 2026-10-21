// A parked job resumed elsewhere (issue #921) whose checkpoint restore finds no way to the hopper in its pane (issue #2316):
// HOPPER_URL not set, or its token file not readable. That pane cannot go on: the start is tried again in a new pane, its way
// to the hopper placed afresh. When no pane gets it, the job fails with a reason the failure assessor knows as transient.
import { describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { matchCause, NO_WAY_TO_HOPPER } from '../../src/failures/causes.ts';
import { CWD, contextFor, jobWith, setup } from './support.ts';

const DONE = { output: ['● Done.', '  HOPPER_DONE'] };
const AT = '2026-10-21T00:00:00.000Z';
const BASE = 'b'.repeat(40);

/** A job parked on another machine, picked up to resume here from its checkpoint. */
const moved = (): Job => jobWith({ prompt: 'go', cwd: CWD }, {
  agentSession: '0f8fad5b-d9cb-469f-a165-70867728950e',
  parked: { at: AT, from: 'running', elsewhere: { at: AT, checkpointAt: AT, from: 'other' } },
  checkpoint: { at: AT, machineId: 'other', base: BASE, head: BASE, commits: [], bytes: 1, session: true },
});

describe('herdr-claude executor: a checkpoint restore with no way to the hopper (issue #2316)', () => {
  it('starts again in a new pane, its way to the hopper placed afresh, and resumes there', async () => {
    const { herdr, executor } = setup({ turns: [DONE], repositories: [CWD], restore: ['no-way', 'restored'] }, { jobWorktrees: true });
    const c = contextFor(moved());
    let placed = 0;
    c.ctx.credentials = async () => ({ HOPPER_URL: `http://hopper.test/${++placed}` });
    expect(await executor.resume!(c.ctx, 'The job moved.')).toMatchObject({ kind: 'finished' });
    expect(herdr.restores).toHaveLength(2);
    expect(placed).toBe(2);
    expect(herdr.agentStarts).toHaveLength(1);
    expect(c.progress.map((p) => p.message).join('\n')).toMatch(/no way to the hopper/);
  });

  it('with no way in any pane: fails with a reason known as transient, never a hand-off with no known cause', async () => {
    const { herdr, executor } = setup({ turns: [DONE], repositories: [CWD], restore: 'no-way' }, { jobWorktrees: true });
    const out = await executor.resume!(contextFor(moved()).ctx, 'The job moved.');
    expect(out.kind).toBe('failed');
    const error = out.kind === 'failed' ? out.error : '';
    expect(error).toContain('the job has no way to the hopper');
    expect(matchCause(error, 'sig', [])?.id).toBe(NO_WAY_TO_HOPPER);
    expect(herdr.restores).toHaveLength(3);
    expect(herdr.agentStarts).toHaveLength(0);
  });

  it('a restore that fails for another reason fails the job at once, as before', async () => {
    const { herdr, executor } = setup({ turns: [DONE], repositories: [CWD], restore: 'failed' }, { jobWorktrees: true });
    const out = await executor.resume!(contextFor(moved()).ctx, 'The job moved.');
    expect(out).toMatchObject({ kind: 'failed', error: expect.stringContaining('the checkpoint could not be restored') });
    expect(herdr.restores).toHaveLength(1);
  });
});
