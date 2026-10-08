import { describe, expect, it } from 'vitest';
import { CWD, contextFor, jobWith, setup } from './support.ts';

// Issue #462: Claude never came up in the pane, herdr's agent start timed out, and the job failed at once.
// Nothing of the job has run by then, so the start is tried again in a new pane; the pane's last output is
// in the job's events either way.
const DONE = { output: ['● Wrote hello.txt.', '  HOPPER_DONE'] };
const STUCK = ['Starting Claude Code…', 'Loading MCP servers (3 of 7)'];

describe('herdr-claude executor: a start that times out is tried again (issue #462)', () => {
  it('a startup timeout is retried in a new pane after a pause; the job runs, the pane\'s last output in its progress', async () => {
    const { herdr, clock, executor } = setup({ turns: [DONE], startupTimeouts: 1, startupTimeoutScreen: STUCK });
    const { ctx, progress, saved } = contextFor(jobWith({ prompt: 'go' }));
    const t0 = clock.now().getTime();
    const out = await executor.run(ctx);
    expect(out.kind, JSON.stringify(out)).toBe('finished');
    expect(herdr.calls.filter((c) => c.method === 'createTab')).toHaveLength(2);
    expect(herdr.closed[0]).toBe('w1:p1');
    expect(herdr.reaps.length).toBeGreaterThanOrEqual(1);
    expect(herdr.prompts).toHaveLength(1);
    expect(herdr.prompts[0]!.name).toBe('jh-abcdef12');
    expect(saved.at(-1)).toMatchObject({ paneId: 'w1:p2' });
    const note = progress.find((p) => p.message?.includes('did not start'))?.message;
    expect(note).toContain('timed out waiting for agent startup');
    expect(note).toContain('Loading MCP servers (3 of 7)');
    expect(note).toMatch(/attempt 1 of 3/);
    expect(clock.now().getTime() - t0).toBeGreaterThanOrEqual(10000);
  });

  it('three startup timeouts in a row: failed, with the pane\'s last output, every pane closed, nothing sent', async () => {
    const { herdr, executor } = setup({ turns: [DONE], startupTimeouts: 3, startupTimeoutScreen: STUCK });
    const { ctx, progress } = contextFor(jobWith({ prompt: 'go' }));
    const out = await executor.run(ctx);
    expect(out.kind).toBe('failed');
    const error = out.kind === 'failed' ? out.error : '';
    expect(error).toMatch(/claude did not start in 3 attempts/);
    expect(error).toContain('timed out waiting for agent startup');
    expect(error).toContain('Loading MCP servers (3 of 7)');
    expect(herdr.closed).toEqual(['w1:p1', 'w1:p2', 'w1:p3']);
    expect(herdr.prompts).toEqual([]);
    expect(progress.filter((p) => p.message?.includes('did not start'))).toHaveLength(2);
  });

  it('a pane that never reaches its shell prompt is tried again in a new pane too', async () => {
    const { herdr, executor } = setup({ turns: [DONE], shellNotReadyStarts: Infinity });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out.kind === 'failed' && out.error).toMatch(/claude did not start in 3 attempts: pane w1:p3 never reached its shell prompt/);
    expect(herdr.closed).toEqual(['w1:p1', 'w1:p2', 'w1:p3']);
  });

  it('a startup blocked by a screen the hopper may not answer is not tried again', async () => {
    const { herdr, executor } = setup({ startupBlockedBy: ['Claude Code needs to update. Press enter.'] });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out.kind === 'failed' && out.error).toMatch(/^claude blocked at startup/);
    expect(herdr.calls.filter((c) => c.method === 'createTab')).toHaveLength(1);
  });

  it('a cancel during the pause ends the job without another pane', async () => {
    const { herdr, executor } = setup({ turns: [DONE], startupTimeouts: 1 });
    const { ctx, ac } = contextFor(jobWith({ prompt: 'go' }));
    const run = executor.run({ ...ctx, progress: (_f, m) => { if (m?.includes('did not start')) ac.abort('cancel'); } });
    const out = await run;
    expect(out.kind).toBe('failed');
    expect(herdr.calls.filter((c) => c.method === 'createTab')).toHaveLength(1);
    expect(herdr.prompts).toEqual([]);
  });

  it('16 lanes filling at once: the starts that time out are tried again, and every job runs', async () => {
    const turns = Array.from({ length: 16 }, () => DONE);
    const { herdr, executor } = setup({ turns, startupTimeouts: 10, startupTimeoutScreen: STUCK });
    const outs = await Promise.all(Array.from({ length: 16 }, (_, i) => {
      const id = `${i.toString(16).padStart(8, '0')}-3456-7890-abcd-ef1234567890`;
      return executor.run(contextFor(jobWith({ prompt: `job ${i}`, cwd: CWD }, { id }), `local/lane-${i + 1}`).ctx);
    }));
    expect(outs.map((o) => o.kind)).toEqual(Array.from({ length: 16 }, () => 'finished'));
    expect(herdr.prompts).toHaveLength(16);
  });
});
