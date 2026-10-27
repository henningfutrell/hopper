// A print-mode agent's turn (issue #865) on a machine where bubblewrap cannot run (issue #2849 part 6): when the job's
// setting routes or scopes it, the turn runs the agent through the bare runner, as a pane's Claude does; a bare runner that
// could not be set up ends the turn. The turn's own run with real CLIs is test/adapters/print-agent-executors.test.ts.
import { describe, expect, it } from 'vitest';
import { bareCommand } from '../../src/client/job-sandbox.ts';
import { isolatedTurn } from '../../src/executors/print-agent.ts';

describe('a print-mode turn with no sandbox (issue #2849 part 6)', () => {
  const scratch = '/w/.worktrees/@scratch/job-1';
  const turn = isolatedTurn('job-1', scratch, 'agent --print');

  it('sets the bare runner up when the sandbox found no bubblewrap, and runs the agent through it when it is on', () => {
    const none = turn.indexOf('*hopper-sandbox-none)');
    expect(none).toBeGreaterThan(-1);
    expect(turn.indexOf(bareCommand(scratch))).toBeGreaterThan(none);
    expect(turn).toContain(`*hopper-bare-on) w='${scratch}/sandbox/run';;`);
    expect(turn).toContain('*hopper-bare-none) ;;');
  });

  it('ends the turn when the bare runner could not be set up', () => {
    expect(turn).toContain('hopper: the job runner could not be set up');
  });
});
