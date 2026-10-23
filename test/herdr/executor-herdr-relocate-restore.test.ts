// A parked job resumed elsewhere (issue #921) whose checkpoint restore finds no way to the hopper in its pane (issue #2316):
// HOPPER_URL not set, or its token file not readable. A new pane on the same machine got none either (issue #2355): the
// job fails at once with a reason the failure assessor knows as transient, marked so the engine places it on another
// machine (`noWayToHopper`).
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

describe('herdr-claude executor: a checkpoint restore with no way to the hopper (issues #2316, #2355)', () => {
  it('fails at once, marked for another machine, with a reason known as transient: no new pane on this machine', async () => {
    const { herdr, executor } = setup({ turns: [DONE], repositories: [CWD], restore: 'no-way' }, { jobWorktrees: true });
    const out = await executor.resume!(contextFor(moved()).ctx, 'The job moved.');
    expect(out).toMatchObject({ kind: 'failed', noWayToHopper: true });
    const error = out.kind === 'failed' ? out.error : '';
    expect(error).toContain('the job has no way to the hopper');
    expect(matchCause(error, 'sig', [])?.id).toBe(NO_WAY_TO_HOPPER);
    expect(herdr.restores).toHaveLength(1);
    expect(herdr.agentStarts).toHaveLength(0);
  });

  // Issue #2639: the remote out of reach (a network outage) is no fault of the checkpoint: it is tried again later.
  it('the remote out of reach: fails at once, marked to be tried again later from the same checkpoint', async () => {
    const { herdr, executor } = setup({ turns: [DONE], repositories: [CWD], restore: 'remote-out-of-reach' }, { jobWorktrees: true });
    const out = await executor.resume!(contextFor(moved()).ctx, 'The job moved.');
    expect(out).toMatchObject({ kind: 'failed', remoteOutOfReach: true, error: expect.stringContaining('the remote is out of reach') });
    expect(out).not.toHaveProperty('noWayToHopper');
    expect(herdr.agentStarts).toHaveLength(0);
  });

  // Issue #2428: a checkpoint whose patch does not apply whole no longer fails the job.
  it('a patch that applied only in part: the job goes on, its progress names what was left out, and the agent is told first', async () => {
    const { herdr, executor } = setup({ turns: [DONE], repositories: [CWD], restore: 'partly' }, { jobWorktrees: true });
    const { ctx, progress } = contextFor(moved());
    const out = await executor.resume!(ctx, 'The job moved.');
    expect(out.kind).toBe('finished');
    expect(herdr.agentStarts).toHaveLength(1);
    expect(progress.map((p) => p.message).join('\n')).toContain('restored the checkpoint in part: its patch did not apply whole, so it left out src/a.ts');
    const told = herdr.prompts.map((t) => t.text).join('\n');
    expect(told).toContain('the patch did not apply whole there');
    expect(told).toContain('`src/a.ts`');
    expect(told).toContain('/w/.git/worktrees/j/hopper-checkpoint.patch');
    expect(told).toContain('The job moved.');
  });

  it('a restore that fails for another reason fails the job at once, as before, with no mark', async () => {
    const { herdr, executor } = setup({ turns: [DONE], repositories: [CWD], restore: 'failed' }, { jobWorktrees: true });
    const out = await executor.resume!(contextFor(moved()).ctx, 'The job moved.');
    expect(out).toMatchObject({ kind: 'failed', error: expect.stringContaining('the checkpoint could not be restored') });
    expect(out).not.toHaveProperty('noWayToHopper');
    expect(out).not.toHaveProperty('remoteOutOfReach');
    expect(herdr.restores).toHaveLength(1);
  });
});
