// The pane key (issue #1569, part of #1524): `herdr tab create` is keyed by the job, its attempt and the pane of the run.
// The key is in the tab's label. A create whose answer was lost (a link that dropped, a timeout) is tried again: the
// hopper first looks for the tab with that key, and takes it when the lost create made it. No second tab, no orphan.
import { describe, expect, it } from 'vitest';
import type { PaneState } from '../../src/executors/herdr/start.ts';
import { contextFor, jobWith, setup } from './support.ts';

const DONE = { output: ['● Done.', '  HOPPER_DONE'] };
const STUCK = ['Starting Claude Code…'];

const labels = (herdr: ReturnType<typeof setup>['herdr']): string[] =>
  herdr.calls.filter((c) => c.method === 'createTab').map((c) => (c.args[0] as { label: string }).label);

describe('herdr-claude executor: the pane key (issue #1569)', () => {
  it('the tab\'s label carries the job, its attempt and the pane of the run', async () => {
    const { herdr, executor } = setup({ turns: [DONE], startupTimeouts: 1, startupTimeoutScreen: STUCK });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' }, { attempts: 3 })).ctx);
    expect(out.kind, JSON.stringify(out)).toBe('finished');
    expect(labels(herdr)).toEqual(['local/lane-1 · abcdef12 · 3.1', 'local/lane-1 · abcdef12 · 3.2']);
  });

  it('a create whose answer was lost: the tab it made is found by its key and used, and no second tab is made', async () => {
    const { herdr, executor } = setup({ turns: [DONE] });
    herdr.loseNextAnswer('createTab');
    const { ctx, saved, progress } = contextFor(jobWith({ prompt: 'go' }));
    const out = await executor.run(ctx);
    expect(out.kind, JSON.stringify(out)).toBe('finished');
    expect(labels(herdr)).toEqual(['local/lane-1 · abcdef12 · 1.1']);
    expect(herdr.calls.filter((c) => c.method === 'findTab')).toHaveLength(1);
    expect(herdr.agentStarts).toHaveLength(1);
    expect(herdr.prompts).toHaveLength(1);
    expect((saved.at(-1) as unknown as PaneState).paneId).toBe('w1:p1');
    expect(herdr.closed).toEqual([]);
    expect(progress.map((p) => p.message).join('\n')).toMatch(/found the job's pane by its key/);
  });

  it('a create that failed before herdr made the tab: tried again with the same key, and the job runs in one tab', async () => {
    const { herdr, executor } = setup({ turns: [DONE] });
    herdr.failNext('createTab', 'timeout');
    const { ctx, saved } = contextFor(jobWith({ prompt: 'go' }));
    const out = await executor.run(ctx);
    expect(out.kind, JSON.stringify(out)).toBe('finished');
    expect(labels(herdr)).toEqual(['local/lane-1 · abcdef12 · 1.1', 'local/lane-1 · abcdef12 · 1.1']);
    expect(await herdr.listPanes()).toHaveLength(1);
    expect((saved.at(-1) as unknown as PaneState).paneId).toBe('w1:p1');
  });

  it('a create that fails at every try: the job fails with herdr\'s error, as before, and nothing is sent', async () => {
    const { herdr, executor } = setup({ turns: [DONE] });
    herdr.failNext('createTab', 'timeout', 3);
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out.kind).toBe('failed');
    expect(out.kind === 'failed' ? out.error : '').toMatch(/^herdr: createTab failed: timeout/);
    expect(labels(herdr)).toHaveLength(3);
    expect(herdr.calls.filter((c) => c.method === 'findTab')).toHaveLength(2);
    expect(herdr.agentStarts).toEqual([]);
    expect(herdr.prompts).toEqual([]);
  });
});
