// The in-memory fake's branches (issue #2914), for fake.ts: a pull request's head branch is there from its opening until it is
// deleted; a test moves its tip, protects it, or marks a pull request a fork's. A merged or closed pull request's head stays at
// the commit it ended on, as on GitHub. The default branch is `main`.
import type { BranchFacts, HeadBranchPull } from '../../domain/head-branches.ts';
import type { BranchRefPage, ReferencingPullRequest } from './api.ts';

type Pull = ReferencingPullRequest & { repo: string; headRef: string; headOid?: string; base?: string; mergedAt?: string; closedAt?: string };
type Calls = 'headBranchPull' | 'branchFacts' | 'deleteBranch' | 'branchRefs';

const PAGE = 2;
const numberOf = (p: Pull): number => Number(p.url.split('/').pop());
const oidOf = (p: Pull): string => p.headOid ?? `oid-${numberOf(p)}`;

export function fakeHeadBranches(pulls: Pull[], enter: (method: Calls, args: unknown[]) => void) {
  const deleted = new Set<string>();
  const set = new Map<string, { tip?: string; protected?: boolean }>();
  const forks = new Set<string>();
  const id = (repo: string, name: string) => `${repo}\n${name}`;
  const named = (repo: string, name: string) => pulls.filter((p) => p.repo === repo && p.headRef === name);
  const tip = (repo: string, name: string): string | undefined => {
    if (deleted.has(id(repo, name))) return undefined;
    return set.get(id(repo, name))?.tip ?? named(repo, name).map(oidOf).at(-1);
  };
  const endedAt = (p: Pull) => { const at = p.mergedAt ?? p.closedAt ?? (p.state === 'open' ? undefined : p.createdAt); return at ? { endedAt: at } : {}; };
  return {
    controls: {
      /** Whether branch `name` of `repo` is there. */
      hasBranch: (repo: string, name: string): boolean => tip(repo, name) !== undefined,
      /** A push to branch `name` (`tip`), or its protection. */
      setBranch(repo: string, name: string, o: { tip?: string; protected?: boolean }): void { set.set(id(repo, name), { ...set.get(id(repo, name)), ...o }); },
      /** Pull request `url`'s head is in a fork. */
      setForkPull(url: string): void { forks.add(url); },
    },
    api: {
      async headBranchPull(repo: string, n: number): Promise<HeadBranchPull | undefined> {
        enter('headBranchPull', [repo, n]);
        const p = pulls.find((x) => x.url === `https://github.com/${repo}/pull/${n}`);
        return p && { url: p.url, state: p.state, headRef: p.headRef, headOid: oidOf(p), fork: forks.has(p.url), defaultBranch: 'main', ...endedAt(p) };
      },
      async branchFacts(repo: string, name: string): Promise<BranchFacts | undefined> {
        enter('branchFacts', [repo, name]);
        const at = tip(repo, name);
        if (at === undefined) return undefined;
        const open = pulls.filter((p) => p.repo === repo && p.state === 'open');
        return { tip: at, protected: set.get(id(repo, name))?.protected ?? false, openHeads: open.filter((p) => p.headRef === name && !forks.has(p.url)).length, openBases: open.filter((p) => p.base === name).length };
      },
      async deleteBranch(repo: string, name: string): Promise<void> {
        enter('deleteBranch', [repo, name]);
        deleted.add(id(repo, name));
      },
      /** A page of `PAGE` branches: the cursor is the index of the next. */
      async branchRefs(repo: string, after?: string): Promise<BranchRefPage> {
        enter('branchRefs', [repo, after]);
        const names = [...new Set(pulls.filter((p) => p.repo === repo).map((p) => p.headRef))].filter((n) => tip(repo, n) !== undefined);
        const from = Number(after ?? 0);
        const refs = names.slice(from, from + PAGE).map((name) => ({
          name, tip: tip(repo, name)!,
          pulls: named(repo, name).map((p) => ({ url: p.url, state: p.state, headOid: oidOf(p), fork: forks.has(p.url), ...endedAt(p) })),
        }));
        return { refs, defaultBranch: 'main', ...(from + PAGE < names.length ? { after: String(from + PAGE) } : {}) };
      },
    },
  };
}
