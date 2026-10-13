// Intake from the listing cache (issue #985 part 2, design.md "Repository listings"): the open labelled issues of the job
// repositories come from each repository's latest repository listing. A repository is listed again when its listing is
// older than the intake sync interval (`intakeSyncMinutes`, a setting of the shared rate limiter), or at once when a
// person asked for the sync; every repository due goes in one listing. A repository GitHub did not answer for is said
// until its next listing, and asked again only then. With no store (tests), the cache is kept in memory.
import type { GitHubListingRepository, ListedItem } from '../../domain/github-listing.ts';
import type { Clock } from '../../domain/ports.ts';
import { GitHubApiError, type GitHubApi, type GitHubIssue } from './api.ts';

/** The listing cache in memory: what a source with no store keeps. */
export function memoryListings(): GitHubListingRepository {
  const kept = new Map<string, { fetchedAt: string; items: ListedItem[] }>();
  return {
    record: (repo, items, fetchedAt) => { kept.set(repo, { fetchedAt, items: items.map((i) => structuredClone(i)) }); },
    listing: (repo) => { const l = kept.get(repo); return l && structuredClone(l); },
    item: (repo, number) => { const i = kept.get(repo)?.items.find((x) => x.number === number); return i && structuredClone(i); },
    forget: (repo) => { kept.delete(repo); },
  };
}

/** An open issue as its listing says it: no body, which a read of the issue gives. */
const issueOf = (i: ListedItem): GitHubIssue => ({
  repo: i.repo, number: i.number, url: i.url, title: i.title, body: '', author: i.author, assignees: [...i.assignees], labels: [...i.labels], state: 'open', updatedAt: i.updatedAt,
});

export interface ListedIssues {
  issues: GitHubIssue[];
  repoErrors: Record<string, string>;
  /** A listing was read from GitHub now. */
  listed: boolean;
}

export interface IntakeListing {
  /** The open issues of `repos` with `label`: the due repositories listed again first; `due` false lists every one. */
  issues(repos: string[], label: string, due: boolean): Promise<ListedIssues>;
}

export function createIntakeListing(o: { api: Pick<GitHubApi, 'listRepos'>; listings: GitHubListingRepository; clock: Clock; everyMs: () => number }): IntakeListing {
  /** When each repository GitHub did not answer for was asked, and what it said. */
  const failed = new Map<string, { at: number; error: string }>();
  const lastAt = (repo: string): number | undefined => {
    const fetched = o.listings.listing(repo)?.fetchedAt;
    const times = [failed.get(repo)?.at, fetched === undefined ? undefined : Date.parse(fetched)].filter((t): t is number => t !== undefined);
    return times.length ? Math.max(...times) : undefined;
  };
  return {
    async issues(repos, label, due) {
      const now = o.clock.now();
      const every = o.everyMs();
      const asked = repos.filter((r) => { const at = lastAt(r); return !due || at === undefined || now.getTime() - at >= every; });
      if (asked.length > 0) {
        const got = await o.api.listRepos(asked, [label]);
        for (const [repo, items] of got.repos) { o.listings.record(repo, items, now.toISOString()); failed.delete(repo); }
        for (const [repo, error] of got.repoErrors) failed.set(repo, { at: now.getTime(), error });
      }
      const repoErrors: Record<string, string> = {};
      const issues: GitHubIssue[] = [];
      for (const repo of repos) {
        const error = failed.get(repo)?.error;
        if (error !== undefined) { repoErrors[repo] = error; continue; }
        for (const i of o.listings.listing(repo)?.items ?? []) if (i.kind === 'issue' && i.labels.includes(label)) issues.push(issueOf(i));
      }
      if (repos.length > 0 && Object.keys(repoErrors).length === repos.length) throw new GitHubApiError(repoErrors[repos[0]!]!, true);
      return { issues, repoErrors, listed: asked.length > 0 };
    },
  };
}
