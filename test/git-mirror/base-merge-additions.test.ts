// The base merge's additions files (issue #967): a repository marks the files whose conflicts the base merge may resolve
// by keeping both sides' added lines, beyond Markdown, with the git attribute `hopper-merge=additions` in its base branch's
// `.gitattributes`. A list whose place is its number — a migrations list — then gets the base branch's entries first and
// the pull request's after them: the pull request's migrations take the next numbers at merge time. Real git, as in
// base-merge.test.ts.
//
// Feature: additions files
//   Scenario: both sides added a migration at the end of a file the base branch marks
//     Then the hopper pushes a merge commit, the base branch's migration first, the pull request's after it
//   Scenario: one side changed a line of a marked file
//     Then nothing is pushed: a real conflict
//   Scenario: only the pull request marks the file
//     Then nothing is pushed: the base branch decides which files are additions files
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGitHubTraffic } from '../../src/github-limiter/traffic.ts';
import { createGitMirrors } from '../../src/git-mirror/mirrors.ts';
import { git } from './support.ts';

const MARK = 'migrations.ts hopper-merge=additions\n';
const list = (...entries: string[]): string => `export const MIGRATIONS = [\n${entries.map((e) => `  '${e}',\n`).join('')}];\n`;

/**
 * An origin: `dev` with `migrations.ts` (two entries) and, unless `marked` is false, the attribute; pull request 1 adds a
 * third entry; 2 changes the second entry; 3 adds a third entry and marks the file itself. Then dev adds its own third entry.
 */
function origin(marked = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jh-base-merge-additions-')));
  const bare = join(root, 'origin.git');
  git(root, 'init', '--quiet', '--bare', '--initial-branch=dev', bare);
  for (const [k, v] of [['uploadpack.allowFilter', 'true'], ['uploadpack.allowAnySHA1InWant', 'true']]) git(bare, 'config', k!, v!);
  const tree = join(root, 'tree');
  git(root, 'clone', '--quiet', bare, tree);
  const commit = (files: Record<string, string>, message: string): string => {
    for (const [f, t] of Object.entries(files)) { writeFileSync(join(tree, f), t); git(tree, 'add', f); }
    git(tree, 'commit', '--quiet', '-m', message);
    return git(tree, 'rev-parse', 'HEAD');
  };
  const base = commit({ 'migrations.ts': list('one', 'two'), ...(marked ? { '.gitattributes': MARK } : {}) }, 'base');
  git(tree, 'push', '--quiet', 'origin', 'dev');
  const heads: Record<number, string> = { 1: commit({ 'migrations.ts': list('one', 'two', 'from the pull request') }, 'pr one') };
  git(tree, 'reset', '--quiet', '--hard', base);
  heads[2] = commit({ 'migrations.ts': list('one', 'changed') }, 'pr two');
  git(tree, 'reset', '--quiet', '--hard', base);
  heads[3] = commit({ 'migrations.ts': list('one', 'two', 'from the pull request'), '.gitattributes': MARK }, 'pr three');
  git(tree, 'reset', '--quiet', '--hard', base);
  const dev = commit({ 'migrations.ts': list('one', 'two', 'from dev') }, 'dev moves on');
  git(tree, 'push', '--quiet', 'origin', 'dev',
    ...[1, 2, 3].flatMap((n) => [`${heads[n]}:refs/heads/issue-${n}`, `${heads[n]}:refs/pull/${n}/head`]));
  return { root, bare, url: `file://${bare}`, heads, dev };
}

function mirrors(root: string) {
  const traffic = createGitHubTraffic({ log: () => undefined });
  return { m: createGitMirrors({ dir: join(root, 'mirrors'), traffic, log: () => undefined }), traffic };
}

const show = (bare: string, rev: string): string => execFileSync('git', ['--git-dir', bare, 'show', rev], { encoding: 'utf8' });

describe("the base merge's additions files (issue #967)", () => {
  it("keeps both sides' added entries of a file the base branch marks, the base branch's first", async () => {
    const o = origin();
    const { m, traffic } = mirrors(o.root);
    const said = await traffic.pass('github', () => m.baseMerge('acme/app', async () => ({ url: o.url }), { number: 1, base: 'dev', headRef: 'issue-1' }));
    expect(said).toEqual({ outcome: 'pushed', commit: expect.stringMatching(/^[0-9a-f]{40}$/), resolved: ['migrations.ts'] });
    const commit = (said as { commit: string }).commit;
    expect(git(o.root, '--git-dir', o.bare, 'rev-parse', 'refs/heads/issue-1')).toBe(commit);
    expect(show(o.bare, `${commit}:migrations.ts`)).toBe(list('one', 'two', 'from dev', 'from the pull request'));
  });

  it('pushes nothing when one side changed a line of a marked file', async () => {
    const o = origin();
    const { m, traffic } = mirrors(o.root);
    const said = await traffic.pass('github', () => m.baseMerge('acme/app', async () => ({ url: o.url }), { number: 2, base: 'dev', headRef: 'issue-2' }));
    expect(said).toEqual({ outcome: 'conflicts', files: ['migrations.ts'] });
    expect(git(o.root, '--git-dir', o.bare, 'rev-parse', 'refs/heads/issue-2')).toBe(o.heads[2]);
  });

  it('pushes nothing when only the pull request marks the file', async () => {
    const o = origin(false);
    const { m, traffic } = mirrors(o.root);
    const said = await traffic.pass('github', () => m.baseMerge('acme/app', async () => ({ url: o.url }), { number: 3, base: 'dev', headRef: 'issue-3' }));
    expect(said).toEqual({ outcome: 'conflicts', files: ['migrations.ts'] });
    expect(git(o.root, '--git-dir', o.bare, 'rev-parse', 'refs/heads/issue-3')).toBe(o.heads[3]);
  });
});
