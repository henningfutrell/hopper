// Intake from the listing cache (issue #985 part 2, design.md "Repository listings"): the open labelled issues of the job
// repositories come from each repository's latest repository listing. A repository is listed again when its listing is
// older than the intake sync interval (`intakeSyncMinutes`, a setting of the shared rate limiter), or at once when a
// person asked for the sync; every repository due goes in one listing. A GitHub delivery (issue #1079) makes one
// repository due at once (`markDue`), so the next timed sync lists it inside the interval. A repository GitHub did not answer for is said
// until its next listing, and asked again only then: an interval after this source asked, whatever another source's listing of it
// keeps fresh in the shared cache (issue #1125). With no store (tests), the cache is kept in memory.
//
// The change read (issue #1125, design.md "Change reads"): with no GitHub delivery, a timed sync inside the interval asks GitHub,
// for each repository it would not list, which issues changed since the newest change its listing holds — one conditional
// request, so an answer GitHub has not changed costs no call; at most once a minute a repository (`CHANGE_READ_EVERY_MS`),
// however often the source syncs. A change the listing does not hold makes the repository due, as
// a delivery does: an open issue with the label not listed, a listed one closed or unlabelled. A listed issue changed otherwise
// has its row read in place, so its listed reads go to GitHub again. A change read that fails changes nothing: the timed
// listing stays.
import type { GitHubListingRepository, ListedItem } from '../../domain/github-listing.ts';
import type { Clock } from '../../domain/ports.ts';
import { CHANGE_READ_PAGE, GitHubApiError, type GitHubApi, type GitHubIssue, type IssueChange } from './api.ts';

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
  /** GitHub said the repository changed (issue #1079): the next listing lists it, whatever the interval. */
  markDue(repo: string): void;
}

/** How often a repository's change read is made at most (issue #1125): a sync after a merge or a rerun makes none sooner. */
export const CHANGE_READ_EVERY_MS = 60_000;

/** The newest change of an issue a listing holds, as GitHub dates it: where its change read starts. Undefined: it holds none. */
const newestOf = (items: ListedItem[]): string | undefined =>
  items.filter((i) => i.kind === 'issue').reduce<string | undefined>((m, i) => (m === undefined || i.updatedAt > m ? i.updatedAt : m), undefined);

/**
 * What a change read says of a listing, for `label` (issue #1125): `due` when it names an issue the listing must take or drop
 * — an open issue with the label not listed, a listed one closed or unlabelled —, or a full page; else the listed issues that
 * changed otherwise (a title, a body, a comment, a label or an assignee), as their rows now read. Pull requests are the
 * listing's and the in-motion cycle's.
 */
export function readChanges(items: ListedItem[], changes: IssueChange[], label: string): { due: boolean; rows: ListedItem[] } {
  if (changes.length >= CHANGE_READ_PAGE) return { due: true, rows: [] };
  const held = new Map(items.filter((i) => i.kind === 'issue').map((i) => [i.number, i]));
  const rows: ListedItem[] = [];
  for (const c of changes.filter((x) => x.kind === 'issue')) {
    const was = held.get(c.number);
    const labelled = c.state === 'open' && c.labels.includes(label);
    if (!was) { if (labelled) return { due: true, rows: [] }; continue; }
    if (!labelled) return { due: true, rows: [] };
    if (c.updatedAt > was.updatedAt) rows.push({ ...was, title: c.title, labels: [...c.labels], assignees: [...c.assignees], updatedAt: c.updatedAt });
  }
  return { due: false, rows };
}

export function createIntakeListing(o: { api: Pick<GitHubApi, 'listRepos' | 'issuesChangedSince'>; listings: GitHubListingRepository; clock: Clock; everyMs: () => number }): IntakeListing {
  /** When each repository GitHub did not answer for was asked, and what it said. */
  const failed = new Map<string, { at: number; error: string }>();
  // A failed repository counts from when this source asked: another source's listing of it does not make it fresh here.
  const lastAt = (repo: string): number | undefined => {
    const f = failed.get(repo);
    if (f) return f.at;
    const fetched = o.listings.listing(repo)?.fetchedAt;
    return fetched === undefined ? undefined : Date.parse(fetched);
  };
  /** When each repository's change read was last made. */
  const readAt = new Map<string, number>();
  /**
   * Whether GitHub says `repo` must be listed again; a listed issue that changed otherwise has its row read in place, so a
   * listed read of it goes to GitHub. False when the change read cannot be made.
   */
  const changed = async (repo: string, label: string): Promise<boolean> => {
    const l = o.listings.listing(repo);
    if (!l) return true;
    const now = o.clock.now().getTime();
    const last = readAt.get(repo);
    if (last !== undefined && now - last < CHANGE_READ_EVERY_MS) return false;
    readAt.set(repo, now);
    let read: ReturnType<typeof readChanges>;
    try {
      read = readChanges(l.items, await o.api.issuesChangedSince!(repo, newestOf(l.items)), label);
    } catch {
      return false;
    }
    if (read.due) return true;
    if (read.rows.length > 0) {
      const fresh = new Map(read.rows.map((r) => [r.number, r]));
      o.listings.record(repo, l.items.map((i) => (i.kind === 'issue' ? fresh.get(i.number) ?? i : i)), l.fetchedAt);
    }
    return false;
  };
  /** The repositories a GitHub delivery made due: cleared when a listing asks for them. */
  const marked = new Set<string>();
  return {
    async issues(repos, label, due) {
      const now = o.clock.now();
      const every = o.everyMs();
      const stale = (r: string) => { const at = lastAt(r); return !due || at === undefined || marked.has(r) || now.getTime() - at >= every; };
      const changedOrStale = new Set(repos.filter(stale));
      if (o.api.issuesChangedSince) for (const r of repos) if (!changedOrStale.has(r) && !failed.has(r) && await changed(r, label)) changedOrStale.add(r);
      const asked = repos.filter((r) => changedOrStale.has(r));
      // Cleared before the listing: a delivery while it reads GitHub marks the repository due again, for the next one.
      for (const r of asked) marked.delete(r);
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
    markDue: (repo) => { marked.add(repo); },
  };
}
