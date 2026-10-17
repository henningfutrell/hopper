// The base merge (issue #967): the hopper merges a pull request's base branch into its head in its own mirror, with no job
// and no lane. A conflict of a Markdown file where both sides only added lines is resolved by keeping both additions, the
// base branch's first; any other conflict is a real one, which a tend job resolves. Real git: an origin served over a
// `file://` URL with blob filters allowed, as GitHub serves one, each pull request's branch and `refs/pull/<n>/head`.
//
// Feature: the base merge
//   Scenario: both sides added a section at the end of docs/design.md
//     Then the hopper pushes a merge commit to the pull request's branch, both sections kept, the base branch's first
//   Scenario: both sides changed the same line of a code file, or of a Markdown file
//     Then nothing is pushed, and the conflicting files are named
//   Scenario: the hopper's git is the container image's, git 2.39 (issue #1624)
//     Then the hopper pushes the same merge commit, both sections kept
//   Scenario: git fails to merge the Markdown file, or its resolution loses the file's lines (issue #1218)
//     Then nothing is pushed, and the file is named
//   Scenario: the branch moved since the fetch
//     Then the push is refused, and git cannot say
//   Scenario: outside a sync pass
//     Then git cannot say, and nothing is fetched
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGitHubTraffic } from '../../src/github-limiter/traffic.ts';
import { createGitMirrors, runGit, type GitRun } from '../../src/git-mirror/mirrors.ts';
import { git, gitOfTheImage } from './support.ts';

const DOC = '# Design\n\nintro\n\nfirst\n\nsecond\n\nthird\n';

/**
 * An origin: `dev`, then pull requests on branches `issue-1` (adds a section to docs/design.md), `issue-2` (changes the
 * line x.ts changes on dev too), `issue-3` (changes the intro line of docs/design.md, which dev changes too); dev then adds
 * its own section to docs/design.md and changes x.ts and the intro.
 */
function origin() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jh-base-merge-')));
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
  const base = commit({ 'docs/design.md': DOC, 'x.ts': 'export const x = 1;\n' }, 'base');
  git(tree, 'push', '--quiet', 'origin', 'dev');
  const heads: Record<number, string> = {
    1: commit({ 'docs/design.md': `${DOC}\n## One\n\nfrom the pull request\n`, 'one.ts': 'export {};\n' }, 'pr one'),
  };
  git(tree, 'reset', '--quiet', '--hard', base);
  heads[2] = commit({ 'x.ts': 'export const x = 2;\n' }, 'pr two');
  git(tree, 'reset', '--quiet', '--hard', base);
  heads[3] = commit({ 'docs/design.md': DOC.replace('intro', 'another intro') }, 'pr three');
  git(tree, 'reset', '--quiet', '--hard', base);
  const dev = commit({ 'docs/design.md': `${DOC.replace('intro', 'the intro')}\n## Two\n\nfrom dev\n`, 'x.ts': 'export const x = 3;\n' }, 'dev moves on');
  git(tree, 'push', '--quiet', 'origin', 'dev',
    ...[1, 2, 3].flatMap((n) => [`${heads[n]}:refs/heads/issue-${n}`, `${heads[n]}:refs/pull/${n}/head`]));
  return { root, bare, url: `file://${bare}`, heads, dev };
}

function mirrors(root: string, git?: GitRun) {
  const lines: string[] = [];
  const traffic = createGitHubTraffic({ log: (l) => lines.push(l) });
  return { m: createGitMirrors({ dir: join(root, 'mirrors'), traffic, log: (l) => lines.push(l), ...(git ? { git } : {}) }), traffic, lines };
}

/** Real git, but `git merge-file` answers `answer`. */
const mergeFileSays = (answer: { code: number; stdout: string; stderr: string }): GitRun =>
  (args, env) => (args.includes('merge-file') ? Promise.resolve(answer) : runGit(args, env));

const show = (bare: string, rev: string): string => execFileSync('git', ['--git-dir', bare, 'show', rev], { encoding: 'utf8' });

describe('the base merge (issue #967)', () => {
  it("pushes a merge commit that keeps both sides' added lines of a Markdown file", async () => {
    const o = origin();
    const { m, traffic } = mirrors(o.root);
    const remote = async () => ({ url: o.url });
    // The intro changed on dev only; both sides added a section at the end.
    const said = await traffic.pass('github', () => m.baseMerge('acme/app', remote, { number: 1, base: 'dev', headRef: 'issue-1' }));
    expect(said).toEqual({ outcome: 'pushed', commit: expect.stringMatching(/^[0-9a-f]{40}$/), resolved: ['docs/design.md'] });
    const commit = (said as { commit: string }).commit;
    expect(git(o.root, '--git-dir', o.bare, 'rev-parse', 'refs/heads/issue-1')).toBe(commit);
    expect(git(o.root, '--git-dir', o.bare, 'rev-list', '--parents', '-n', '1', commit).split(' ').slice(1)).toEqual([o.heads[1], o.dev]);
    expect(show(o.bare, `${commit}:docs/design.md`)).toBe(`${DOC.replace('intro', 'the intro')}\n## Two\n\nfrom dev\n\n## One\n\nfrom the pull request\n`);
    expect(show(o.bare, `${commit}:x.ts`)).toBe('export const x = 3;\n');
    expect(show(o.bare, `${commit}:one.ts`)).toBe('export {};\n');
    expect(git(o.root, '--git-dir', o.bare, 'log', '-1', '--format=%an <%ae>%n%s', commit)).toBe("hopper <hopper@noreply.invalid>\nMerge branch 'dev' into issue-1");
  });

  it("keeps both sides' added lines with the container image's git 2.39 too (issue #1624)", async () => {
    const o = origin();
    const { m, traffic } = mirrors(o.root, gitOfTheImage);
    const said = await traffic.pass('github', () => m.baseMerge('acme/app', async () => ({ url: o.url }), { number: 1, base: 'dev', headRef: 'issue-1' }));
    expect(said).toEqual({ outcome: 'pushed', commit: expect.stringMatching(/^[0-9a-f]{40}$/), resolved: ['docs/design.md'] });
    const commit = (said as { commit: string }).commit;
    expect(show(o.bare, `${commit}:docs/design.md`)).toBe(`${DOC.replace('intro', 'the intro')}\n## Two\n\nfrom dev\n\n## One\n\nfrom the pull request\n`);
  });

  it('pushes nothing and names the files when a code file or a changed Markdown line conflicts', async () => {
    const o = origin();
    const { m, traffic } = mirrors(o.root);
    const remote = async () => ({ url: o.url });
    const said = await traffic.pass('github', async () => [
      await m.baseMerge('acme/app', remote, { number: 2, base: 'dev', headRef: 'issue-2' }),
      await m.baseMerge('acme/app', remote, { number: 3, base: 'dev', headRef: 'issue-3' }),
    ]);
    expect(said).toEqual([{ outcome: 'conflicts', files: ['x.ts'] }, { outcome: 'conflicts', files: ['docs/design.md'] }]);
    expect(git(o.root, '--git-dir', o.bare, 'rev-parse', 'refs/heads/issue-2')).toBe(o.heads[2]);
    expect(git(o.root, '--git-dir', o.bare, 'rev-parse', 'refs/heads/issue-3')).toBe(o.heads[3]);
  });

  it('pushes nothing when git fails to merge the Markdown file: no empty file (issue #1218)', async () => {
    for (const code of [128, 129, 255]) {
      const o = origin();
      const { m, traffic } = mirrors(o.root, mergeFileSays({ code, stdout: '', stderr: 'fatal: git failed' }));
      const said = await traffic.pass('github', () => m.baseMerge('acme/app', async () => ({ url: o.url }), { number: 1, base: 'dev', headRef: 'issue-1' }));
      expect(said).toEqual({ outcome: 'conflicts', files: ['docs/design.md'] });
      expect(git(o.root, '--git-dir', o.bare, 'rev-parse', 'refs/heads/issue-1')).toBe(o.heads[1]);
    }
  });

  it('pushes nothing when the resolution loses most of the file\'s lines: the shrink guard (issue #1218)', async () => {
    const o = origin();
    const [open, mid, sep, close] = ['<', '|', '=', '>'].map((c) => c.repeat(40));
    const { m, traffic, lines } = mirrors(o.root, mergeFileSays({ code: 1, stdout: `${open} ours\n## One\n${mid} base\n${sep}\n${close} theirs\n`, stderr: '' }));
    const said = await traffic.pass('github', () => m.baseMerge('acme/app', async () => ({ url: o.url }), { number: 1, base: 'dev', headRef: 'issue-1' }));
    expect(said).toEqual({ outcome: 'conflicts', files: ['docs/design.md'] });
    expect(git(o.root, '--git-dir', o.bare, 'rev-parse', 'refs/heads/issue-1')).toBe(o.heads[1]);
    expect(lines.some((l) => l.includes('base merge of #1: the shrink guard') && l.includes('docs/design.md'))).toBe(true);
  });

  it('cannot say when the branch moved since the fetch, or outside a pass', async () => {
    const o = origin();
    const { m, traffic, lines } = mirrors(o.root);
    const remote = async () => ({ url: o.url });
    expect(await m.baseMerge('acme/app', remote, { number: 1, base: 'dev', headRef: 'issue-1' })).toBeUndefined();
    expect(lines).toEqual([]);
    const said = await traffic.pass('github', async () => {
      await m.mergeability('acme/app', remote, { number: 1, base: 'dev', headOid: o.heads[1]! });
      git(o.root, '--git-dir', o.bare, 'update-ref', 'refs/heads/issue-1', o.heads[2]!);
      return m.baseMerge('acme/app', remote, { number: 1, base: 'dev', headRef: 'issue-1' });
    });
    expect(said).toBeUndefined();
    expect(git(o.root, '--git-dir', o.bare, 'rev-parse', 'refs/heads/issue-1')).toBe(o.heads[2]);
    expect(lines.some((l) => l.startsWith('hopper: git mirror of acme/app: base merge of #1: push refused'))).toBe(true);
  });

  it('refuses a branch name git must not take, and the base branch itself', async () => {
    const o = origin();
    const { m, traffic } = mirrors(o.root);
    const remote = async () => ({ url: o.url });
    const said = await traffic.pass('github', async () => [
      await m.baseMerge('acme/app', remote, { number: 1, base: 'dev', headRef: '--upload-pack=x' }),
      await m.baseMerge('acme/app', remote, { number: 1, base: 'dev', headRef: 'dev' }),
    ]);
    expect(said).toEqual([undefined, undefined]);
  });
});
