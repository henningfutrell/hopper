// Whether a job's push holds push requirements (issue #2555), read in the hopper's mirror: the pushed commit's tree and
// its base's tip (issue #2712). Real git: an origin served over a `file://` URL with blob filters allowed, as GitHub serves
// one; the job's push pack is git's own.
//
// Feature: the requirements a push holds
//   Scenario: a branch made before its base kept a requirements file
//     Then the push holds requirements, and the files it changes are its own
//   Scenario: git cannot read the pushed commit, and the base holds a requirements file
//     Then the push still holds requirements, with no changed files
//   Scenario: git cannot read the pushed commit, and the base holds none
//     Then git cannot say
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGitHubTraffic } from '../../src/github-limiter/traffic.ts';
import { runGit, type GitRun } from '../../src/git-mirror/mirrors.ts';
import { createHoldsRequirements } from '../../src/git-mirror/push-requirements-at.ts';
import { git } from './support.ts';

/** An origin whose `dev` adds `.hopper/requirements.yaml` (or a readme) after `issue-1` left it; `issue-1` adds x.kt, unpushed. */
function origin(baseFile: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jh-push-requirements-at-')));
  const bare = join(root, 'origin.git');
  git(root, 'init', '--quiet', '--bare', '--initial-branch=dev', bare);
  for (const [k, v] of [['uploadpack.allowFilter', 'true'], ['uploadpack.allowAnySHA1InWant', 'true']]) git(bare, 'config', k!, v!);
  const tree = join(root, 'tree');
  git(root, 'clone', '--quiet', bare, tree);
  const commit = (file: string, text: string, message: string): string => {
    mkdirSync(dirname(join(tree, file)), { recursive: true });
    writeFileSync(join(tree, file), text);
    git(tree, 'add', file);
    git(tree, 'commit', '--quiet', '-m', message);
    return git(tree, 'rev-parse', 'HEAD');
  };
  const start = commit('a.txt', 'one\n', 'base');
  git(tree, 'push', '--quiet', 'origin', 'dev');
  git(tree, 'checkout', '--quiet', '-b', 'issue-1');
  const head = commit('x.kt', 'class X\n', 'add X');
  git(tree, 'checkout', '--quiet', 'dev');
  const dev = baseFile ? commit('.hopper/requirements.yaml', 'requirements: []\n', 'requirements') : commit('README.md', 'hi\n', 'readme');
  git(tree, 'push', '--quiet', 'origin', 'dev');
  const pack = execFileSync('git', ['pack-objects', '--stdout', '--thin', '--revs', '--quiet'], { cwd: tree, input: `${head}\n^${start}\n^${dev}\n` });
  return { root, url: `file://${bare}`, head, pack };
}

function holds(root: string, gitRun: GitRun = runGit) {
  const said: string[] = [];
  return { read: createHoldsRequirements({ dir: join(root, 'mirrors'), traffic: createGitHubTraffic({ log: () => {} }), log: (l) => said.push(l), git: gitRun }), said };
}

/** Real git, but the pushed commit cannot be listed in the push's quarantine, as when its pack lacks what it is made on. */
const commitUnread: GitRun = (args, env) =>
  (args.includes('ls-tree') && env.GIT_OBJECT_DIRECTORY ? Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: not a tree object' }) : runGit(args, env));

describe('the requirements a push holds (issues #2555, #2712)', () => {
  it('a branch made before its base kept a requirements file holds the base\'s', async () => {
    const o = origin(true);
    const h = holds(o.root);
    expect(await h.read('octo/tools', async () => ({ url: o.url }), { base: 'dev', new: o.head, pack: o.pack })).toEqual({ file: true, files: ['x.kt'] });
  });

  it('git cannot read the pushed commit: the base\'s requirements file still holds', async () => {
    const o = origin(true);
    const h = holds(o.root, commitUnread);
    expect(await h.read('octo/tools', async () => ({ url: o.url }), { base: 'dev', new: o.head, pack: o.pack })).toEqual({ file: true, files: [] });
    expect(h.said.join('\n')).toContain('ls-tree: fatal: not a tree object');
  });

  it('git cannot read the pushed commit, and the base holds no requirements file: git cannot say', async () => {
    const o = origin(false);
    const h = holds(o.root, commitUnread);
    expect(await h.read('octo/tools', async () => ({ url: o.url }), { base: 'dev', new: o.head, pack: o.pack })).toBeUndefined();
    expect(await holds(o.root).read('octo/tools', async () => ({ url: o.url }), { base: 'dev', new: o.head, pack: o.pack })).toEqual({ file: false, files: ['x.kt'] });
  });
});
