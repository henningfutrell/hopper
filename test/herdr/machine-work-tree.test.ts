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
  const { remotes, executor } = setup({}, { jobWorktrees: true, remote: { laptop: { turns: [DONE] } } });
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

  it('the machine\'s work tree is made when missing, wherever it is', async () => {
    const r = await run({}, { ...FAR, workTree: '/srv/trees' });
    expect(r.runs.find((c) => c.includes('hopper-scratch'))).toMatch(/^mkdir -p '\/srv\/trees' && cd '\/srv\/trees' && /);
  });

  it('a job from a repository: the job worktree command names it, to fetch or clone it in a work tree that is no repository, and Claude starts in its worktree', async () => {
    const fromRepo = { source: { source: 'github', kind: 'github-account', key: 'k', url: 'u', title: 't', author: 'a', repo: 'acme/app' } };
    const r = await run({}, { ...FAR, workTree: '/srv/trees' }, fromRepo);
    expect(r.out).toMatchObject({ kind: 'finished' });
    const command = r.runs.find((c) => c.includes('hopper-worktree'))!;
    expect(command).toMatch(/^cd '\/srv\/trees' && \{ printf 'hopper-%s-%s\\n' worktree running; o=\$\(sh -c '.*' hopper-worktree '[^']*' '\/srv\/trees\/workspace\/worktrees\/app-[^/']+' 'acme\/app' 'https:\/\/github\.com\/acme\/app\.git' '1'/s);
    // No GitHub token anywhere (issue #652): git asks the hopper, through the variables the job runs with.
    expect(command).not.toMatch(/GH_TOKEN|gh auth|credential\.helper/);
    expect(r.workTrees.at(-1)).toMatch(/^\/srv\/trees\/workspace\/worktrees\/app-[^/]+$/);
  });

  it('a job with no repository names none to the job worktree command', async () => {
    const r = await run({}, { ...FAR, workTree: '/srv/trees' });
    expect(r.runs.filter((c) => c.includes('hopper-worktree')).every((c) => / '' '' '1'/.test(c))).toBe(true);
  });
});

// Issue #691: one machine works on more than one repository. A job from a repository the machine maps
// works in that repository's work tree there; a job from any other works in the machine's own.
describe('herdr-claude executor: a work tree per repository (issue #691)', () => {
  const from = (repo: string) => ({ source: { source: 'github', kind: 'github-account', key: 'k', url: 'u', title: 't', author: 'a', repo } });
  const MAPPED = { ...FAR, workTree: '~/wt/platform', workTrees: { 'Acme/Monolith': '~/wt/monolith' } };

  it('a job from a mapped repository works in its work tree, resolved on the machine; the repository is matched in any case', async () => {
    const r = await run({}, MAPPED, from('acme/monolith'));
    expect(r.out).toMatchObject({ kind: 'finished' });
    expect(r.workTrees[0]).toBe('/home/far/wt/monolith');
    expect(r.runs.find((c) => c.includes('hopper-worktree'))).toMatch(/^cd '\/home\/far\/wt\/monolith' && /);
  });

  it('a mapped work tree that is missing is made, and the repository cloned in it: never the machine\'s own work tree', async () => {
    const r = await run({}, MAPPED, from('acme/monolith'));
    expect(r.runs.find((c) => c.includes('hopper-scratch'))).toMatch(/^mkdir -p '\/home\/far\/wt\/monolith' && cd '\/home\/far\/wt\/monolith' && /);
    expect(r.runs.join('\n')).not.toContain('/home/far/wt/platform');
  });

  it('a job from a repository the machine does not map, or from none, works in the machine\'s own work tree', async () => {
    expect((await run({}, MAPPED, from('acme/platform'))).workTrees[0]).toBe('/home/far/wt/platform');
    expect((await run({}, MAPPED)).workTrees).toEqual(['/home/far/wt/platform']);
  });

  it('a job\'s own work tree, on the machine it is pinned to, still wins over the map', async () => {
    const pinned = { ...from('acme/monolith'), spec: { executor: 'herdr-claude', machineId: 'laptop', payload: { prompt: 'go', cwd: '~/code/app' } } };
    expect((await run({ cwd: '~/code/app' }, MAPPED, pinned)).workTrees[0]).toBe('/home/far/code/app');
  });

  it('a mapped work tree that is the machine\'s home fails the job, naming it', async () => {
    const r = await run({}, { ...MAPPED, workTrees: { 'acme/monolith': '~' } }, from('acme/monolith'));
    expect(r.out).toMatchObject({ kind: 'failed', error: expect.stringContaining('the work tree ~ on laptop is its home or above it') });
  });
});
