// Real git for the mirror tests (issue #858 part 2): an origin served over a `file://` URL with blob filters allowed,
// as GitHub serves one, its pull request heads at `refs/pull/<n>/head`.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_CONFIG_NOSYSTEM: '1' };
export const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: 'pipe' }).trim();

/**
 * An origin with `dev`, pull request 1 (a new file: merges clean) and 2 (the same line as dev changed: conflicts); 3 (the
 * file 1 adds, other text: conflicts with 1) and 4 (another new file: conflicts with none), both clean on `dev`.
 */
export function origin(): { root: string; url: string; heads: Record<number, string>; tree: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jh-git-mirror-')));
  const bare = join(root, 'origin.git');
  git(root, 'init', '--quiet', '--bare', '--initial-branch=dev', bare);
  for (const [k, v] of [['uploadpack.allowFilter', 'true'], ['uploadpack.allowAnySHA1InWant', 'true']]) git(bare, 'config', k!, v!);
  const tree = join(root, 'tree');
  git(root, 'clone', '--quiet', bare, tree);
  const commit = (file: string, text: string, message: string): string => {
    writeFileSync(join(tree, file), text);
    git(tree, 'add', file);
    git(tree, 'commit', '--quiet', '-m', message);
    return git(tree, 'rev-parse', 'HEAD');
  };
  const base = commit('a.txt', 'one\n', 'one');
  git(tree, 'push', '--quiet', 'origin', 'dev');
  const one = commit('b.txt', 'new\n', 'pr one');
  git(tree, 'reset', '--quiet', '--hard', base);
  const two = commit('a.txt', 'two\n', 'pr two');
  git(tree, 'reset', '--quiet', '--hard', base);
  const three = commit('b.txt', 'other\n', 'pr three');
  git(tree, 'reset', '--quiet', '--hard', base);
  const four = commit('c.txt', 'four\n', 'pr four');
  git(tree, 'reset', '--quiet', '--hard', base);
  commit('a.txt', 'three\n', 'dev moves on');
  git(tree, 'push', '--quiet', 'origin', 'dev', `${one}:refs/pull/1/head`, `${two}:refs/pull/2/head`, `${three}:refs/pull/3/head`, `${four}:refs/pull/4/head`);
  return { root, url: `file://${bare}`, heads: { 1: one, 2: two, 3: three, 4: four }, tree };
}

