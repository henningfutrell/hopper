// The hopper's mirror (issue #858 part 2): git, not GitHub's `mergeable`, says whether a pull request merges into its
// base. Real git: the origin a bare repository served over a `file://` URL with blob filters allowed, as GitHub serves
// one, its pull request heads at `refs/pull/<n>/head`.
//
// Feature: mergeability from the hopper's mirror
//   Scenario: a clean and a conflicting pull request in one sync pass
//     Then merge-tree says clean and conflicting, the mirror is bare and blobless, and it was fetched once
//   Scenario: a second sync pass
//     Then the mirror is fetched again, once
//   Scenario: outside a sync pass, a head that moved, another base
//     Then git cannot say, and nothing is fetched outside a pass
//   Scenario: two pull requests that change the same lines, and two that do not (issue #939)
//     Then merge-tree of their heads says they conflict, or not, with one fetch; an unknown one, git cannot say
//   Scenario: what a pull request changes (issue #935 part 2)
//     Then its commits after the merge base and the files it changes, from the pass's fetch, with no blob; outside a
//     pass or a head that moved, git cannot say
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGitHubTraffic } from '../../src/github-limiter/traffic.ts';
import { createGitMirrors, mirrorPathOf, runGit, type GitRun } from '../../src/git-mirror/mirrors.ts';
import { git, origin } from './support.ts';

function mirrors(dir: string) {
  const lines: string[] = [];
  const traffic = createGitHubTraffic({ log: (l) => lines.push(l) });
  const fetches: string[][] = [];
  const counted: GitRun = (args, env) => { if (args.includes('fetch')) fetches.push(args); return runGit(args, env); };
  const m = createGitMirrors({ dir, traffic, git: counted, log: (l) => lines.push(l) });
  return { m, traffic, lines, fetches };
}

describe("the hopper's mirror (issue #858 part 2)", () => {
  it('says clean and conflicting with merge-tree, fetched once in the pass, bare and blobless', async () => {
    const o = origin();
    const dir = join(o.root, 'mirrors');
    const { m, traffic, lines, fetches } = mirrors(dir);
    const remote = async () => ({ url: o.url });
    const [clean, again] = await traffic.pass('github', () => Promise.all([
      m.mergeability('acme/app', remote, { number: 1, base: 'dev', headOid: o.heads[1]! }),
      m.mergeability('acme/app', remote, { number: 1, base: 'dev', headOid: o.heads[1]! }),
    ]));
    expect([clean, again]).toEqual(['clean', 'clean']);
    const path = mirrorPathOf(dir, 'acme/app');
    expect(git(o.root, '--git-dir', path, 'rev-parse', '--is-bare-repository')).toBe('true');
    expect(git(o.root, '--git-dir', path, 'config', 'remote.origin.partialclonefilter')).toBe('blob:none');
    // A merge where only one side changed a file reads no blob: none came.
    const blobs = git(o.root, '--git-dir', path, 'cat-file', '--batch-all-objects', '--batch-check=%(objecttype)').split('\n').filter((t) => t === 'blob');
    expect(blobs).toEqual([]);

    const conflict = await traffic.pass('github', () => m.mergeability('acme/app', remote, { number: 2, base: 'dev', headOid: o.heads[2]! }));
    expect(conflict).toBe('conflicting');
    expect(fetches).toHaveLength(2);
    expect(fetches[0]).toEqual(expect.arrayContaining(['--prune', '--filter=blob:none', '+refs/heads/dev:refs/remotes/origin/dev', '+refs/pull/*/head:refs/remotes/origin/pull/*']));
    expect(lines.filter((l) => l.startsWith('hopper: GitHub traffic'))).toEqual([
      'hopper: GitHub traffic of sync pass github: REST 0, GraphQL 0, git fetches 1 (acme/app 1; by hopper 1)',
      'hopper: GitHub traffic of sync pass github: REST 0, GraphQL 0, git fetches 1 (acme/app 1; by hopper 1)',
    ]);
  });

  it('cannot say outside a pass, for a head that moved, or for another base', async () => {
    const o = origin();
    const { m, traffic, fetches } = mirrors(join(o.root, 'mirrors'));
    const remote = async () => ({ url: o.url });
    expect(await m.mergeability('acme/app', remote, { number: 1, base: 'dev', headOid: o.heads[1]! })).toBeUndefined();
    expect(fetches).toEqual([]);
    const [moved, other, unknown] = await traffic.pass('github', async () => [
      await m.mergeability('acme/app', remote, { number: 1, base: 'dev', headOid: o.heads[2]! }),
      await m.mergeability('acme/app', remote, { number: 1, base: 'main', headOid: o.heads[1]! }),
      await m.mergeability('acme/app', remote, { number: 9, base: 'dev', headOid: o.heads[1]! }),
    ]);
    expect([moved, other, unknown]).toEqual([undefined, undefined, undefined]);
    expect(fetches).toHaveLength(1);
  });

  it('cannot say when the fetch fails, and says why without the token', async () => {
    const o = origin();
    const { m, traffic, lines } = mirrors(join(o.root, 'mirrors'));
    const remote = async () => ({ url: `file://${o.root}/missing.git`, token: 'ghs_secret' });
    expect(await traffic.pass('github', () => m.mergeability('acme/app', remote, { number: 1, base: 'dev', headOid: o.heads[1]! }))).toBeUndefined();
    const said = lines.filter((l) => l.startsWith('hopper: git mirror of acme/app:'));
    expect(said).toHaveLength(1);
    expect(lines.join('\n')).not.toContain('ghs_secret');
  });

  it('says whether two pull requests conflict with each other (issue #939), with one fetch', async () => {
    const o = origin();
    const { m, traffic, fetches } = mirrors(join(o.root, 'mirrors'));
    const remote = async () => ({ url: o.url });
    const said = await traffic.pass('github', async () => [
      await m.conflictBetween('acme/app', remote, 'dev', 1, 3),
      await m.conflictBetween('acme/app', remote, 'dev', 1, 4),
      await m.conflictBetween('acme/app', remote, 'dev', 3, 4),
      await m.conflictBetween('acme/app', remote, 'dev', 1, 9),
      await m.conflictBetween('acme/app', remote, 'main', 1, 4),
    ]);
    expect(said).toEqual([true, false, false, undefined, undefined]);
    expect(fetches).toHaveLength(1);
    expect(await m.conflictBetween('acme/app', remote, 'dev', 1, 3)).toBeUndefined();
  });

  it('says what a pull request changes: its commits and its files, from the pass\'s fetch, with no blob (issue #935 part 2)', async () => {
    const o = origin();
    const dir = join(o.root, 'mirrors');
    const { m, traffic, fetches } = mirrors(dir);
    const remote = async () => ({ url: o.url });
    const [one, two, moved] = await traffic.pass('github', async () => [
      await m.changes('acme/app', remote, { number: 1, base: 'dev', headOid: o.heads[1]! }),
      await m.changes('acme/app', remote, { number: 2, base: 'dev', headOid: o.heads[2]! }),
      await m.changes('acme/app', remote, { number: 1, base: 'dev', headOid: o.heads[2]! }),
    ]);
    expect(one).toEqual({ commits: [`${o.heads[1]!.slice(0, 7)} pr one`], files: ['b.txt'] });
    expect(two).toEqual({ commits: [`${o.heads[2]!.slice(0, 7)} pr two`], files: ['a.txt'] });
    expect(moved).toBeUndefined();
    expect(fetches).toHaveLength(1);
    const blobs = git(o.root, '--git-dir', mirrorPathOf(dir, 'acme/app'), 'cat-file', '--batch-all-objects', '--batch-check=%(objecttype)').split('\n').filter((t) => t === 'blob');
    expect(blobs).toEqual([]);
    expect(await m.changes('acme/app', remote, { number: 1, base: 'dev', headOid: o.heads[1]! })).toBeUndefined();
  });
});
