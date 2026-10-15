// Checks fallback (issue #1244, design.md "Checks the hopper may not read"): a pull request whose checks GitHub's GraphQL
// rollup would not give (`unknown`, issue #855) has them read again over REST with the same connection — its head commit's
// check runs and combined status (`headChecks`) —, so yolo mode merges it once they pass. Nothing falls back to another
// credential. Where that read is refused too, the checks stay `unknown` and say why (`checksWhy`): the connection, the
// permissions it lacks, and the fix; `checksRefused` marks it, so the Pull requests list makes its repository's one checks
// read problem of it. A read that fails otherwise keeps GitHub's error, and no mark. Which read works is kept per repository: a refused one is not asked again for
// UNREADABLE_KEEP_MS, so a pass over many pull requests of that repository asks GitHub once.
// Every read of the port that tells a pull request's checks goes through it; the port's other methods are the adapter's own.
import { pullKey, type GitHubApi, type HeadChecks, type OpenPullRequest, type PullRequestState } from './api.ts';

/** How long a repository whose checks no read gets is not asked again: a permission added since is seen after it. */
export const UNREADABLE_KEEP_MS = 10 * 60_000;

/** The connection the source reads with, as a person knows it, and how to give it the permissions. */
export interface ChecksConnection { name: string; fix: string }

export const ACCOUNT_CONNECTION: ChecksConnection = {
  name: 'the connected GitHub account',
  // Issue #1351: the account reaches a repository only where the hopper's app is installed with it.
  fix: "install the hopper's GitHub App on the repository's owner with this repository, accept its new permissions on the installation, then connect GitHub again",
};

const PERMISSIONS = { checks: 'Checks: read', statuses: 'Commit statuses: read' } as const;
const PULL_URL = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+\/?$/;

type Path = { read: 'rest' } | { read: 'none'; why: string; until: number };
type Checked = Pick<OpenPullRequest, 'checks' | 'checksWhy' | 'checksRefused' | 'headOid' | 'headRef'>;

/** `api` with each `unknown` checks read again over REST, or said why not. */
export function checksFallback(api: GitHubApi, connection: ChecksConnection, now: () => number = Date.now): GitHubApi {
  const paths = new Map<string, Path>();
  const lacks = (missing: (keyof typeof PERMISSIONS)[], either = false): string =>
    `${connection.name} lacks ${missing.map((m) => PERMISSIONS[m]).join(either ? ' or ' : ' and ')}: ${connection.fix}`;

  const answered = async <P extends Checked>(repo: string, pr: P): Promise<P> => {
    if (pr.checks !== 'unknown') return pr;
    const key = repo.toLowerCase();
    const path = paths.get(key);
    if (path?.read === 'none' && now() < path.until) return { ...pr, checksWhy: path.why, checksRefused: true };
    const ref = pr.headOid ?? pr.headRef;
    if (!ref || !api.headChecks) return { ...pr, checksWhy: lacks(['checks', 'statuses'], true), checksRefused: true };
    let got: HeadChecks;
    try {
      got = await api.headChecks(repo, ref);
    } catch (err) {
      return { ...pr, checksWhy: `GitHub did not answer the read of its checks: ${(err as Error).message}` };
    }
    if ('unreadable' in got) {
      const why = lacks(got.unreadable);
      paths.set(key, { read: 'none', why, until: now() + UNREADABLE_KEEP_MS });
      return { ...pr, checksWhy: why, checksRefused: true };
    }
    paths.set(key, { read: 'rest' });
    const { checks: _c, checksWhy: _w, checksRefused: _r, ...rest } = pr;
    return { ...rest, ...(got.checks ? { checks: got.checks } : {}) } as P;
  };
  /** One after the other: the first refusal of a repository spares the rest of its pull requests a read. */
  const each = async <P extends OpenPullRequest & { repo?: string }>(fallback: string, prs: P[]): Promise<P[]> => {
    const out: P[] = [];
    for (const pr of prs) out.push(await answered(pr.repo ?? PULL_URL.exec(pr.url)?.[1] ?? fallback, pr));
    return out;
  };

  const out: Partial<GitHubApi> = {
    openClosingPullRequests: async (repo, number) => each(repo, await api.openClosingPullRequests(repo, number)),
    referencingPullRequests: async (repo, number) => each(repo, await api.referencingPullRequests(repo, number)),
    pullRequest: async (repo, number) => {
      const pr = await api.pullRequest(repo, number);
      return pr && answered(repo, pr);
    },
    openPullRequests: async (repo) => each(repo, await api.openPullRequests(repo)),
    pullRequestStates: async (refs) => {
      const got = await api.pullRequestStates(refs);
      const pulls = new Map<string, PullRequestState>();
      for (const [key, state] of got.pulls) {
        const repo = refs.find((r) => pullKey(r.repo, r.pullRequest) === key)?.repo ?? key.split('#')[0]!;
        pulls.set(key, await answered(repo, state));
      }
      return { ...got, pulls };
    },
  };
  return Object.assign(Object.create(api) as GitHubApi, out);
}
