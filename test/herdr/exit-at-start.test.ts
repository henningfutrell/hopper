// Issue #2432: a new session's Claude that exits before it shows anything fails as an exit at start, with its exit code and
// what it printed, not the setup commands' tail; the failure assessor runs it again off that lane, never a person's.
import { describe, expect, it } from 'vitest';
import { EXIT_CODE_COMMAND, claudeSaid, exitCodeOf } from '../../src/executors/herdr/exited.ts';
import { matchCause } from '../../src/failures/causes.ts';
import { assess } from '../../src/failures/assess.ts';
import { DEFAULT_FAILURE_SETTINGS } from '../../src/domain/types.ts';
import { isLaneFault } from '../../src/reliability/fault.ts';
import { avoidLanesOf } from '../../src/engine/lane-health.ts';
import { contextFor, jobWith, setup } from './support.ts';

const SESSION = '0b7c5e2a-1111-4222-8333-944455556666';

describe('what Claude left when it exited', () => {
  it('reads the last exit code the shell printed, never the echo of its command', () => {
    expect(exitCodeOf(`$ ${EXIT_CODE_COMMAND}\nhopper-claude-exit-1\n$ `)).toBe(1);
    expect(exitCodeOf(`$ ${EXIT_CODE_COMMAND}\n$ `)).toBeUndefined();
    expect(exitCodeOf('hopper-claude-exit-0\nhopper-claude-exit-143')).toBe(143);
  });

  it('keeps what Claude printed after its command line, without the setup before it or the prompt after it', () => {
    const screen = [
      'hopper-job-worktree-made', 'hopper-deps-none', 'hopper-claude-config-kept',
      `box% claude --dangerously-skip-permissions --session-id ${SESSION}`,
      'Error: something Claude said on stderr', '', `Resume this session with: claude --resume ${SESSION}`, 'box%',
    ].join('\n');
    expect(claudeSaid(screen)).toBe(`Error: something Claude said on stderr\n\nResume this session with: claude --resume ${SESSION}`);
  });

  it('keeps the screen\'s last lines when its command line is gone', () => {
    expect(claudeSaid('● Segfault in the matrix\n$ ')).toBe('● Segfault in the matrix');
  });
});

describe('herdr-claude executor: Claude exits at the start of a new session', () => {
  it('fails as an exit at start, with its exit code and what it printed', async () => {
    const { herdr, executor } = setup({ turns: [{ output: [], end: 'exit' }], claudeExitCode: 1 });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out.kind === 'failed' && out.error).toMatch(/^claude exited at the start of a new session, before any output \(exit code 1\): /);
    // Not the setup's tail: what came before Claude's command line.
    expect(out.kind === 'failed' && out.error).not.toMatch(/hopper-(scratch|tmp|sandbox|runtime)-/);
    expect(herdr.calls.some((c) => c.method === 'runInPane' && c.args[1] === EXIT_CODE_COMMAND)).toBe(true);
  });

  it('names the signal that ended it', async () => {
    const { executor } = setup({ turns: [{ output: [], end: 'exit' }], claudeExitCode: 143 });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out.kind === 'failed' && out.error).toContain('(exit code 143, signal 15)');
  });

  it('is no exit at start once Claude showed something in its turn', async () => {
    const { executor } = setup({ turns: [{ steps: ['● Reading the issue'], output: ['● Segfault in the matrix'], end: 'exit' }], claudeExitCode: 2 });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out.kind === 'failed' && out.error).toMatch(/^claude exited \(exit code 2\): /);
    expect(out.kind === 'failed' && out.error).toContain('Segfault in the matrix');
  });
});

describe('an exit at start is the seat\'s fault', () => {
  const atStart = `claude exited at the start of a new session, before any output (exit code 1): Resume this session with: claude --resume ${SESSION}`;

  it('is the known cause Exited at start, a lane fault, as Claude exiting at startup is', () => {
    expect(matchCause(atStart, '', [])?.id).toBe('exited-at-start');
    expect(matchCause('claude exited at startup (exit code unknown): (it printed nothing)', '', [])?.id).toBe('exited-at-start');
    expect(isLaneFault(atStart)).toBe(true);
    // What Claude printed may name a cause of its own: a sign-in that expired holds the executor.
    expect(matchCause('claude exited at startup (exit code 1): Not logged in · Please run /login', '', [])?.id).toBe('login-expired');
  });

  it('runs again by itself, never a person\'s, and the rerun avoids the lane', () => {
    const a = assess({
      error: atStart, signature: 's1', cause: matchCause(atStart, 's1', []), job: { executor: 'herdr-claude', machineId: 'seat', pinned: false },
      attempt: 1, recent: [], settings: DEFAULT_FAILURE_SETTINGS,
    });
    expect(a).toMatchObject({ cls: 'transient', decision: 'retry', auto: true });
    const failed = jobWith({ prompt: 'go' }, { id: 'j1', status: 'failed', laneId: 'seat/lane-1', error: atStart });
    const rerun = jobWith({ prompt: 'go' }, { id: 'j2', status: 'queued', rerunOf: 'j1' });
    expect(avoidLanesOf([rerun], (id) => (id === 'j1' ? failed : undefined))).toEqual({ j2: 'seat/lane-1' });
  });
});
