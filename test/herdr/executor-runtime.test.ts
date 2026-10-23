// The job's own container runtime (issue #1295): set up in the pane's shell after it entered the job's scope, so the
// runtime's socket runs in the scope, and before Claude starts, so Claude and all it runs see only the job's runtime. A
// setup that failed fails the job before Claude starts: it would run next to the host's runtime.
import { describe, expect, it } from 'vitest';
import { contextFor, jobWith, JOB_ID, setup } from './support.ts';
import { TERMINAL_LINE_MAX } from '../../src/executors/herdr/client.ts';

const DONE = { output: ['Done.', 'HOPPER_DONE'] };

describe('herdr-claude executor: the job\'s own container runtime (issue #1295)', () => {
  it('is set up after the scope and before Claude, for this job and its scratch dir, with its socket', async () => {
    const { herdr, executor } = setup({ turns: [DONE], scopes: true, runtime: 'own' });
    const { ctx, progress } = contextFor(jobWith({ prompt: 'go' }));
    expect(await executor.run(ctx)).toMatchObject({ kind: 'finished' });
    const order = herdr.calls.map((c) => (c.method === 'runInPane' ? String(c.args[1]) : c.method));
    const check = order.findIndex((m) => m.startsWith('case "$(cat /proc/self/cgroup'));
    const runtime = order.findIndex((m) => m.includes(' hopper-runtime '));
    expect(runtime).toBeGreaterThan(check);
    expect(order.indexOf('startAgent')).toBeGreaterThan(runtime);
    const command = order[runtime]!;
    expect(command).toContain(`'${JOB_ID}'`);
    expect(command).toContain(`/.worktrees/@scratch/${JOB_ID}'`);
    expect(command).toMatch(/ service\); /);
    expect(command).toContain(`/.worktrees/@scratch/${JOB_ID}/containers/env.sh'`);
    expect(progress.some((p) => p.message?.includes('container runtime: the job\'s own'))).toBe(true);
  });

  it('a shell with no line editor runs it: each command typed into the pane fits a terminal line, the guards before the setup (issue #2234)', async () => {
    const { herdr, executor } = setup({ turns: [DONE], scopes: true, runtime: 'own' });
    expect(await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx)).toMatchObject({ kind: 'finished' });
    const typed = herdr.calls.filter((c) => c.method === 'runInPane').map((c) => String(c.args[1]));
    expect(typed.filter((c) => c.length > TERMINAL_LINE_MAX)).toEqual([]);
    const guards = typed.findIndex((c) => c.includes(' hopper-guards '));
    expect(guards).toBeGreaterThan(-1);
    expect(typed.findIndex((c) => c.includes(' hopper-runtime '))).toBe(guards + 1);
  });

  it('is saved in the job\'s state once set up, for its resource ledger (issue #2504): its dir in the scratch dir', async () => {
    const { executor } = setup({ turns: [DONE], scopes: true, runtime: 'own' });
    const { ctx, saved } = contextFor(jobWith({ prompt: 'go' }));
    expect(await executor.run(ctx)).toMatchObject({ kind: 'finished' });
    const first = saved.findIndex((s) => typeof s.containerRuntime === 'string');
    expect(saved[first]!.containerRuntime).toMatch(new RegExp(`/\\.worktrees/@scratch/${JOB_ID}/containers$`));
    expect(saved.slice(first).every((s) => s.containerRuntime === saved[first]!.containerRuntime)).toBe(true);
  });

  it('a machine with no podman: the job runs, told it has no runtime', async () => {
    const { herdr, executor } = setup({ turns: [DONE] });
    const { ctx, progress, saved } = contextFor(jobWith({ prompt: 'go' }));
    expect(await executor.run(ctx)).toMatchObject({ kind: 'finished' });
    expect(herdr.agentStarts).toHaveLength(1);
    expect(saved.some((s) => s.containerRuntime !== undefined)).toBe(false);
    expect(progress.some((p) => p.message?.includes('container runtime: none for the job here'))).toBe(true);
  });

  it('a setup that failed fails the job before Claude starts', async () => {
    const { herdr, executor } = setup({ turns: [DONE], runtime: 'failed' });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out).toMatchObject({ kind: 'failed', error: expect.stringMatching(/^the job's own container runtime could not be set up on /) });
    expect(herdr.agentStarts).toEqual([]);
  });
});
