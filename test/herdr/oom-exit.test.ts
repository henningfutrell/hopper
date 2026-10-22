// Issue #2498: a Claude that exits after the kernel's OOM killer stopped processes in the job's scope fails as a
// resource limit, not as the job's code: the failure says how many, and the failure assessor runs it again by itself.
import { describe, expect, it } from 'vitest';
import { OOM_KILLS_MARK, oomKillsCommand, oomKillsOf } from '../../src/executors/herdr/exited.ts';
import { matchCause } from '../../src/failures/causes.ts';
import { assess } from '../../src/failures/assess.ts';
import { DEFAULT_FAILURE_SETTINGS } from '../../src/domain/types.ts';
import { contextFor, jobWith, setup } from './support.ts';

describe('the OOM kills in the job\'s scope', () => {
  it('reads the last count the shell printed, never the echo of its command', () => {
    expect(oomKillsOf(`$ ${oomKillsCommand('j1')}\n${OOM_KILLS_MARK}2\n$ `)).toBe(2);
    expect(oomKillsOf(`$ ${oomKillsCommand('j1')}\n$ `)).toBeUndefined();
    expect(oomKillsOf(`${OOM_KILLS_MARK}none`)).toBeUndefined();
  });

  it('reads only the job\'s own scope, from the shell\'s own cgroup', () => {
    expect(oomKillsCommand('j1')).toContain('/proc/self/cgroup');
    expect(oomKillsCommand('j1')).toContain("*/hopper-job-j1.scope)");
    expect(oomKillsCommand('j1')).toContain('memory.events');
  });
});

describe('herdr-claude executor: Claude exits after an OOM kill in its scope', () => {
  it('fails as a resource limit, with the count, its exit code and what it printed', async () => {
    const { executor } = setup({ turns: [{ steps: ['● Building'], output: ['● Running the build'], end: 'exit' }], claudeExitCode: 137, scopes: true, oomKills: 2 });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out.kind === 'failed' && out.error).toMatch(/^claude exited \(exit code 137, signal 9\) at a resource limit: the kernel's OOM killer stopped 2 processes in the job's scope: /);
  });

  it('is no resource limit with no OOM kill, or with no scope', async () => {
    const none = await setup({ turns: [{ steps: ['● Building'], output: ['● x'], end: 'exit' }], claudeExitCode: 1, scopes: true, oomKills: 0 }).executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(none.kind === 'failed' && none.error).toMatch(/^claude exited \(exit code 1\): /);
    const unscoped = await setup({ turns: [{ steps: ['● Building'], output: ['● x'], end: 'exit' }], claudeExitCode: 137, oomKills: 2 }).executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(unscoped.kind === 'failed' && unscoped.error).toMatch(/^claude exited \(exit code 137, signal 9\): /);
  });
});

describe('a job stopped at its resource limit runs again', () => {
  const error = 'claude exited (exit code 137, signal 9) at a resource limit: the kernel\'s OOM killer stopped 1 process in the job\'s scope: Killed';

  it('is the known cause Resource limit, before what Claude printed', () => {
    expect(matchCause(error, '', [])?.id).toBe('resource-limit');
    expect(matchCause(`${error}\nNot logged in · Please run /login`, '', [])?.id).toBe('resource-limit');
  });

  it('runs again by itself, never a person\'s', () => {
    const a = assess({
      error, signature: 's1', cause: matchCause(error, 's1', []), job: { executor: 'herdr-claude', machineId: 'seat', pinned: false },
      attempt: 1, recent: [], settings: DEFAULT_FAILURE_SETTINGS,
    });
    expect(a).toMatchObject({ cls: 'transient', decision: 'retry', auto: true });
  });
});
