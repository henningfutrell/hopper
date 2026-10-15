// Issue #1188: every job worktree is `<wd>/.worktrees/<repository name>/<job id>`, never in a repository's checkout and
// never a path the hopper made up elsewhere; the hopper's own areas are beside them in `.worktrees`. The client's scripts
// (src/client/reap.ts) keep the same names, since the client imports nothing of hopper.
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { DEPS_AREA, SCRATCH_AREA, WORKTREES_DIR, jobScratchOf, jobWorktreeAt, scratchParts, worktreeParts } from '../../src/domain/job-layout.ts';
import { LAYOUT } from '../../src/client/reap.ts';
import { jobWorktreeOf, makeJobWorktreeCommand } from '../../src/executors/herdr/job-worktree.ts';
import { shareDepsCommand } from '../../src/executors/herdr/shared-deps.ts';
import { scratchCommand } from '../../src/executors/herdr/start.ts';
import { ID, git, repository, served, sh } from '../herdr/job-worktree-support.ts';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const WORK_TREES = ['/w', '/w/', '/home/me/jobs', '/srv/trees/monolith//'];
const REPOS = [undefined, 'acme/app', 'acme/.github', 'Acme/App-2', 'app'];
const under = (wd: string): string => `${wd.replace(/(.)\/+$/, '$1')}/${WORKTREES_DIR}/`;

describe('the job worktree layout (issue #1188)', () => {
  it('puts every job worktree at <wd>/.worktrees/<repository name>/<job id>, and nowhere else', () => {
    for (const wd of WORK_TREES) {
      for (const repo of REPOS) {
        const path = jobWorktreeOf(wd, ID, repo);
        expect(path.startsWith(under(wd)), path).toBe(true);
        expect(path.slice(under(wd).length).split('/'), path).toHaveLength(2);
        expect(path.endsWith(`/${ID}`), path).toBe(true);
        expect(path).not.toMatch(/\/workspace\/|\.hopper-scratch/);
        expect(worktreeParts(path)).toEqual({ workTree: wd.replace(/(.)\/+$/, '$1'), name: ID, old: false });
      }
    }
  });

  it('every command that makes or uses a job worktree names only paths under <wd>/.worktrees', () => {
    for (const wd of ['/w', '/home/me/jobs']) {
      for (const command of [makeJobWorktreeCommand(wd, ID), makeJobWorktreeCommand(wd, ID, { repo: 'acme/app' }), scratchCommand(wd, ID, true), shareDepsCommand(wd, jobWorktreeOf(wd, ID, 'acme/app'), 24)]) {
        expect(command).not.toMatch(/hopper-scratch\/|\.hopper-scratch|workspace\/worktrees/);
      }
    }
  });

  it('made for real, every job worktree git knows of is under <wd>/.worktrees: of the work tree, and of a checkout in its workspace', () => {
    const { root, tree } = repository();
    sh(tree, makeJobWorktreeCommand(tree, ID));
    const bare = join(root, 'acme', 'app.git');
    mkdirSync(join(root, 'acme'));
    git(root, 'clone', '--quiet', '--bare', join(root, 'origin.git'), bare);
    const plain = join(root, 'jobs');
    mkdirSync(plain);
    sh(plain, makeJobWorktreeCommand(plain, ID, { repo: 'acme/app', url: served(bare) }));
    for (const [wd, repo] of [[tree, tree], [plain, join(plain, 'workspace', 'app')]] as const) {
      const listed = git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
      const jobs = listed.filter((p) => p !== repo);
      expect(jobs).toHaveLength(1);
      for (const p of jobs) expect(p.startsWith(under(wd)), p).toBe(true);
    }
    expect(spawnSync('git', ['check-ignore', '-q', join(tree, WORKTREES_DIR, 'tree', ID)], { cwd: tree }).status).toBe(0);
  });

  it('keeps the hopper\'s own areas beside the worktrees, under names no repository has', () => {
    expect(jobScratchOf('/w/', 'j1')).toBe(`/w/${WORKTREES_DIR}/${SCRATCH_AREA}/j1`);
    expect([SCRATCH_AREA, DEPS_AREA].every((a) => a.startsWith('@'))).toBe(true);
    expect(worktreeParts(`/w/${WORKTREES_DIR}/${SCRATCH_AREA}/j1`)).toBeUndefined();
    expect(worktreeParts(jobWorktreeAt('/w', 'acme/app', 'j1'))).toEqual({ workTree: '/w', name: 'j1', old: false });
  });

  it('reads the layout before only to remove what it left', () => {
    expect(scratchParts('/w/.hopper-scratch/j1')).toEqual({ workTree: '/w', jobId: 'j1' });
    expect(scratchParts('/w/.worktrees/@scratch/j1')).toEqual({ workTree: '/w', jobId: 'j1' });
    expect(scratchParts('/w/.worktrees/@scratch/j1/repo')).toBeUndefined();
    expect(worktreeParts('/w/workspace/worktrees/app-j1')).toEqual({ workTree: '/w', name: 'app-j1', old: true });
  });

  it('the client\'s scripts use the same names', () => {
    expect(LAYOUT.worktrees).toBe(WORKTREES_DIR);
    expect(LAYOUT.scratch).toBe(`${WORKTREES_DIR}/${SCRATCH_AREA}`);
  });
});
