// The shrink guard's git half (issue #1096): a job's push, read before it reaches GitHub, in the hopper's mirror — its
// pack indexed in a quarantine of its own, never in the mirror — and each file it or the branch changes counted in lines
// at the four commits the guard judges by. A push that does not bring in its base branch is not judged. Real git: an
// origin served over a `file://` URL with blob filters allowed, as GitHub serves one; the job's push pack is git's own.
//
// Feature: the lines of a push that brings in its base branch
//   Scenario: a rebase onto the base branch that empties docs/design.md
//     Then each changed file's lines at the branch's start, its head, the base as brought in and the push
//     And the mirror keeps none of the push's objects
//   Scenario: a push that only adds a commit to the branch
//     Then it brings nothing in, and is not judged
//   Scenario: the base branch cannot be read
//     Then git cannot say
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGitHubTraffic } from '../../src/github-limiter/traffic.ts';
import { createGitMirrors } from '../../src/git-mirror/mirrors.ts';
import { git } from './support.ts';

const lines = (n: number, word: string) => Array.from({ length: n }, (_, i) => `${word} ${i}`).join('\n') + '\n';

/** An origin: `dev` with docs/design.md (100 lines) and x.ts; branch `issue-1` edits both; dev then adds to the design. */
function origin() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jh-push-lines-')));
  const bare = join(root, 'origin.git');
  git(root, 'init', '--quiet', '--bare', '--initial-branch=dev', bare);
  for (const [k, v] of [['uploadpack.allowFilter', 'true'], ['uploadpack.allowAnySHA1InWant', 'true']]) git(bare, 'config', k!, v!);
  const tree = join(root, 'tree');
  git(root, 'clone', '--quiet', bare, tree);
  const write = (file: string, text: string) => { mkdirSync(dirname(join(tree, file)), { recursive: true }); writeFileSync(join(tree, file), text); git(tree, 'add', file); };
  const commit = (files: Record<string, string>, message: string): string => {
    for (const [f, t] of Object.entries(files)) write(f, t);
    git(tree, 'commit', '--quiet', '-m', message);
    return git(tree, 'rev-parse', 'HEAD');
  };
  const start = commit({ 'docs/design.md': lines(100, 'design'), 'x.ts': lines(10, 'x') }, 'base');
  git(tree, 'push', '--quiet', 'origin', 'dev');
  git(tree, 'checkout', '--quiet', '-b', 'issue-1');
  const head = commit({ 'docs/design.md': lines(101, 'design'), 'x.ts': lines(12, 'x') }, 'pr one');
  git(tree, 'push', '--quiet', 'origin', 'issue-1');
  git(tree, 'checkout', '--quiet', 'dev');
  const dev = commit({ 'docs/design.md': lines(120, 'design') }, 'dev moves on');
  git(tree, 'push', '--quiet', 'origin', 'dev');
  return { root, bare, tree, url: `file://${bare}`, start, head, dev, commit };
}

/** git's own thin pack of `tip`, against what the origin has: the branch's head and the base branch. */
const packOf = (tree: string, tip: string, has: string[]): Buffer =>
  execFileSync('git', ['pack-objects', '--stdout', '--thin', '--revs', '--quiet'], { cwd: tree, input: [tip, ...has.map((h) => `^${h}`)].join('\n') + '\n' });

function mirrors(root: string) {
  const said: string[] = [];
  const traffic = createGitHubTraffic({ log: (l) => said.push(l) });
  const dir = join(root, 'mirrors');
  return { m: createGitMirrors({ dir, traffic, log: (l) => said.push(l) }), said, dir };
}

describe('the lines of a push that brings in its base branch (issue #1096)', () => {
  it('a rebase onto dev that empties docs/design.md: each file\'s lines at the four commits, the mirror untouched', async () => {
    const o = origin();
    const { m, dir } = mirrors(o.root);
    // The job's resolution: on dev's tip, the pull request's x.ts kept, docs/design.md emptied.
    git(o.tree, 'checkout', '--quiet', '-b', 'tended', o.dev);
    const pushed = o.commit({ 'docs/design.md': '', 'x.ts': lines(12, 'x') }, 'rebased');
    const said = await m.pushLines('acme/app', async () => ({ url: o.url }), { base: 'dev', old: o.head, new: pushed, pack: packOf(o.tree, pushed, [o.head, o.dev]) });
    expect(said).toEqual({ brings: true, files: expect.arrayContaining([
      { path: 'docs/design.md', start: 100, head: 101, base: 120, pushed: 0 },
      { path: 'x.ts', start: 10, head: 12, base: 10, pushed: 12 },
    ]) });
    expect((said as { files: unknown[] }).files).toHaveLength(2);
    // The push's commit stays out of the mirror: only the quarantine had it, and it is gone.
    const mirror = join(dir, 'acme/app.git');
    expect(() => execFileSync('git', ['--git-dir', mirror, 'cat-file', '-e', `${pushed}^{commit}`], { stdio: 'pipe' })).toThrow();
    expect(readdirSync(mirror).filter((f) => f.startsWith('hopper-quarantine'))).toEqual([]);
  });

  it('a removed file has no lines after', async () => {
    const o = origin();
    const { m } = mirrors(o.root);
    git(o.tree, 'checkout', '--quiet', '-b', 'tended', o.dev);
    git(o.tree, 'rm', '--quiet', 'docs/design.md');
    const pushed = o.commit({ 'x.ts': lines(12, 'x') }, 'rebased');
    const said = await m.pushLines('acme/app', async () => ({ url: o.url }), { base: 'dev', old: o.head, new: pushed, pack: packOf(o.tree, pushed, [o.head, o.dev]) });
    expect(said).toEqual({ brings: true, files: expect.arrayContaining([{ path: 'docs/design.md', start: 100, head: 101, base: 120 }]) });
  });

  it('a push that only adds a commit to the branch brings nothing in', async () => {
    const o = origin();
    const { m } = mirrors(o.root);
    git(o.tree, 'checkout', '--quiet', 'issue-1');
    const pushed = o.commit({ 'docs/design.md': '' }, 'the pull request empties it itself');
    expect(await m.pushLines('acme/app', async () => ({ url: o.url }), { base: 'dev', old: o.head, new: pushed, pack: packOf(o.tree, pushed, [o.head, o.dev]) }))
      .toEqual({ brings: false });
  });

  it('a base branch git cannot read: git cannot say', async () => {
    const o = origin();
    const { m, said } = mirrors(o.root);
    expect(await m.pushLines('acme/app', async () => ({ url: o.url }), { base: 'nope', old: o.head, new: o.dev, pack: Buffer.alloc(0) })).toBeUndefined();
    expect(said.join('\n')).toContain('acme/app');
    expect(existsSync(join(o.root, 'mirrors'))).toBe(true);
  });
});
