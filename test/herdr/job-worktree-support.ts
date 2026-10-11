// Real git for the job worktree tests (test/herdr/job-worktree*.test.ts): the pane's shell is sh, the git the
// machine's own, the origin a bare repository beside the work tree.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobScratchOf } from '../../src/executors/herdr/start.ts';

export const ID = 'abcdef12-3456-7890-abcd-ef1234567890';
export const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_CONFIG_NOSYSTEM: '1' };

export const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: 'pipe' }).trim();

/** Runs the command as the pane's shell would, then `after` in the same shell; what it printed. */
export function sh(cwd: string, command: string, after = ''): string {
  // What the scratch command did first: the job's scratch dir, the scratch dirs ignored.
  mkdirSync(jobScratchOf(cwd, ID), { recursive: true });
  writeFileSync(join(cwd, '.hopper-scratch', '.gitignore'), '*\n');
  const r = spawnSync('sh', ['-c', `${command}${after ? `\n${after}` : ''}`], { cwd, env: GIT_ENV, encoding: 'utf8' });
  return `${r.stdout}${r.stderr}`;
}

/** A clone of a bare origin, with one commit on main, and the origin one commit ahead of it. */
export function repository(): { root: string; tree: string; origin: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jh-job-worktree-')));
  const origin = join(root, 'origin.git');
  git(root, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  const tree = join(root, 'tree');
  git(root, 'clone', '--quiet', origin, tree);
  writeFileSync(join(tree, 'a.txt'), 'one\n');
  git(tree, 'add', 'a.txt');
  git(tree, 'commit', '--quiet', '-m', 'one');
  git(tree, 'push', '--quiet', 'origin', 'main');
  git(root, 'clone', '--quiet', origin, join(root, 'other'));
  writeFileSync(join(root, 'other', 'b.txt'), 'two\n');
  git(join(root, 'other'), 'add', 'b.txt');
  git(join(root, 'other'), 'commit', '--quiet', '-m', 'two');
  git(join(root, 'other'), 'push', '--quiet', 'origin', 'main');
  return { root, tree, origin };
}
