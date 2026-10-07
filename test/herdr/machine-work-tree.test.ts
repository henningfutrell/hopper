// Issue #361: a job's work tree is its machine's. A path set for one machine never reaches another: the
// job's own work tree (a routing rule's, which pins the machine) applies only on the machine it is pinned
// to; anywhere else the machine's work tree, else the jobs directory. The hopper makes the work tree and
// fetches or clones the job's repository into it, in the pane's own shell, before Claude starts.
import { describe, expect, it } from 'vitest';
import type { FakeTurn } from '../../src/executors/herdr/index.ts';
import { LAPTOP, contextFor, jobWith, setup } from './support.ts';

const DONE: FakeTurn = { output: ['● Done.', '  HOPPER_DONE'] };
const { workTree: _none, ...BARE } = LAPTOP;
const FAR = { ...BARE, home: '/home/far' };

const run = async (payload: Record<string, unknown>, machine: typeof FAR & { workTree?: string }, extra: Parameters<typeof jobWith>[1] = {}) => {
  const { remotes, executor } = setup({}, { remote: { laptop: { turns: [DONE] } } });
  const { ctx, workTrees } = contextFor(jobWith({ prompt: 'go', ...payload }, extra), 'laptop/lane-1', machine);
  const out = await executor.run(ctx);
  const runs = remotes.get('laptop')!.calls.filter((c) => c.method === 'runInPane').map((c) => String(c.args[1]));
  return { out, workTrees, runs };
};

describe('herdr-claude executor: the work tree is the machine\'s (issue #361)', () => {
  it('the machine\'s work tree, resolved there', async () => {
    const r = await run({}, { ...FAR, workTree: '~/trees' });
    expect(r.out).toMatchObject({ kind: 'finished' });
    expect(r.workTrees).toEqual(['/home/far/trees']);
  });

  it('a machine with no work tree of its own: the jobs directory there; a source default in the payload is never used', async () => {
    expect((await run({}, FAR)).workTrees).toEqual(['/home/far/hopper-jobs']);
    expect((await run({ defaultCwd: '/home/owner/code' }, FAR)).workTrees).toEqual(['/home/far/hopper-jobs']);
  });

  it('the job\'s own work tree applies on the machine it is pinned to', async () => {
    const pinned = { spec: { executor: 'herdr-claude', machineId: 'laptop', payload: { prompt: 'go', cwd: '~/code/app' } } };
    const r = await run({ cwd: '~/code/app' }, { ...FAR, workTree: '/srv/trees' }, pinned);
    expect(r.workTrees).toEqual(['/home/far/code/app']);
  });

  it('a job\'s own work tree is never applied on another machine: there it runs in that machine\'s work tree', async () => {
    const elsewhere = { spec: { executor: 'herdr-claude', machineId: 'other', payload: { prompt: 'go', cwd: '/home/owner/work' } } };
    expect((await run({ cwd: '/home/owner/work' }, { ...FAR, workTree: '/srv/trees' }, elsewhere)).workTrees).toEqual(['/srv/trees']);
    // A job pinned nowhere that carries a path (queued before) runs in the machine's work tree too.
    const nowhere = { spec: { executor: 'herdr-claude', machineId: undefined, payload: { prompt: 'go', cwd: '/home/owner/work' } } };
    expect((await run({ cwd: '/home/owner/work' }, FAR, nowhere)).workTrees).toEqual(['/home/far/hopper-jobs']);
  });

  it('the work tree is made when missing, wherever it is', async () => {
    const r = await run({}, { ...FAR, workTree: '/srv/trees' });
    expect(r.runs.at(-1)).toMatch(/^mkdir -p '\/srv\/trees' && cd '\/srv\/trees' && /);
  });

  it('a job from a repository: its checkout is fetched, or cloned, in the work tree before Claude starts', async () => {
    const fromRepo = { source: { source: 'github', kind: 'github-account', key: 'k', url: 'u', title: 't', author: 'a', repo: 'acme/app' } };
    const r = await run({}, { ...FAR, workTree: '/srv/trees' }, fromRepo);
    expect(r.out).toMatchObject({ kind: 'finished' });
    const command = r.runs.at(-1)!;
    expect(command).toMatch(/^mkdir -p '\/srv\/trees' && cd '\/srv\/trees' && sh -c '.*' hopper-checkout 'acme\/app' 'https:\/\/github\.com\/acme\/app\.git' && mkdir -p /s);
    // The token stays in the pane's environment: the command names the variable, never a value.
    expect(command).toContain('$GH_TOKEN');
    expect(command).toContain('clone');
    expect(command).toContain('fetch');
  });

  it('a job with no repository makes the work tree and its scratch dir only', async () => {
    const r = await run({}, { ...FAR, workTree: '/srv/trees' });
    expect(r.runs.at(-1)).not.toContain('hopper-checkout');
  });
});
