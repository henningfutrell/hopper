// The release check (issue #652, design.md "Self-update"): the hopper updates only to a commit that is the merge of a
// pull request whose checks passed. A push straight to a channel's branch, a pull request with no checks, a check that
// failed or has not finished, and a commit GitHub cannot be asked about are all held. Asked of GitHub's REST API with a
// connected GitHub account's token (issue #822), never with none: github.com gives an address with no token 60 calls an
// hour, shared with everything else on it. GitHub's rate limit holds the commit until its reset time, said in the reason.
import type { Clock, ConnectedAccountTokens, ReleaseCheck, ReleaseVerdict } from '../domain/ports.ts';
import type { GitHubLimiter } from '../github-limiter/limiter.ts';
import { tokenCaller, type TokenSource } from '../github-proxy/index.ts';
import { makeRequest, statusOf } from '../sources/github/app/http.ts';

/** github.com's REST API: where the update repository is asked about. */
export const GITHUB_API = 'https://api.github.com';
/** How long an answer that can still change (checks running, failed, none) is kept before GitHub is asked again. */
export const RELEASE_RETRY_MS = 5 * 60_000;
/** A check run's conclusions that count as passed; at least one must be `success`. */
const PASSED = new Set(['success', 'neutral', 'skipped']);
/** The message GitHub gives the merge commit of pull request N. */
const MERGE_MESSAGE = /^Merge pull request #(\d+) /;
const GITHUB_REPO = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

interface Pull { number: number; html_url: string; merged_at: string | null; merge_commit_sha: string | null; head: { sha: string } }
interface Run { name: string; status: string; conclusion: string | null }

const short = (sha: string): string => sha.slice(0, 7);

/** The owner and name of a repository URL on github.com; undefined for any other. */
export function githubRepoOf(url: string): { owner: string; repo: string } | undefined {
  const m = GITHUB_REPO.exec(url.trim());
  return m ? { owner: m[1]!, repo: m[2]! } : undefined;
}

/** The verdict on the check runs of pull request `n`'s head; `settled` when no later answer can change it. */
export function checksVerdict(pr: { number: number; url: string }, runs: Run[]): { verdict: ReleaseVerdict; settled: boolean } {
  const held = (reason: string) => ({ verdict: { passed: false as const, reason }, settled: false });
  if (runs.length === 0) return held(`pull request #${pr.number} has no checks: no checks is not passing`);
  const failed = runs.filter((r) => r.status === 'completed' && !PASSED.has(r.conclusion ?? ''));
  if (failed.length) return held(`a check of pull request #${pr.number} did not pass: ${failed.map((r) => `${r.name} (${r.conclusion ?? 'none'})`).join(', ')}`);
  const running = runs.filter((r) => r.status !== 'completed');
  if (running.length) return held(`the checks of pull request #${pr.number} have not finished: ${running.map((r) => r.name).join(', ')}`);
  if (!runs.some((r) => r.conclusion === 'success')) return held(`no check of pull request #${pr.number} succeeded`);
  return { verdict: { passed: true, pullRequest: pr }, settled: true };
}

/** When GitHub refused a call for the rate (a 403 or 429 with no calls left, or `retry-after`): the time it may be asked again, in ms; else undefined. */
export function rateLimitedUntil(err: unknown, now: number): number | undefined {
  const status = statusOf(err);
  if (status !== 403 && status !== 429) return undefined;
  const headers = (err as { response?: { headers?: Record<string, string | number | undefined> } }).response?.headers ?? {};
  const after = Number(headers['retry-after']);
  if (Number.isFinite(after) && after > 0) return now + after * 1000;
  const reset = Number(headers['x-ratelimit-reset']);
  if (String(headers['x-ratelimit-remaining']) === '0' && Number.isFinite(reset)) return reset * 1000;
  return status === 429 ? now + 60_000 : undefined;
}

/**
 * The account the release check asks with: the first of `accounts` (the users', oldest first) whose GitHub connection
 * lives and is on `apiUrl` — a GitHub Enterprise token is no good on github.com. Its token is asked at each check.
 */
export function releaseAccount(accounts: ConnectedAccountTokens[], apiUrl = GITHUB_API): TokenSource | { problem: string } {
  const a = accounts.find((x) => x.account('github') !== undefined && x.endpoints('github').apiUrl === apiUrl);
  if (!a) return { problem: `no user has a GitHub connection on ${apiUrl}: an admin connects one in Sources → Connect GitHub` };
  return { token: () => a.token('github'), renew: (refused) => a.renew('github', refused) };
}

const hhmm = (ms: number): string => new Date(ms).toISOString().slice(11, 16);

export function createReleaseCheck(o: {
  /** Default: github.com's. */
  apiUrl?: string; clock: Clock; retryMs?: number;
  /** The GitHub account the check asks with, its token asked at each check; or why there is none (then nothing is asked). */
  github: () => TokenSource | { problem: string };
  /** The shared rate limiter unless a test gives one. */
  limiter?: GitHubLimiter;
}): ReleaseCheck {
  const apiUrl = o.apiUrl ?? GITHUB_API;
  const req = o.limiter ? makeRequest(apiUrl, o.limiter) : makeRequest(apiUrl);
  const retryMs = o.retryMs ?? RELEASE_RETRY_MS;
  // A settled answer never changes; another is asked again once it is `retryMs` old, or at GitHub's reset when rate-limited.
  const known = new Map<string, { verdict: ReleaseVerdict; settled: boolean; at: number; until?: number }>();

  async function ask(account: TokenSource, gh: { owner: string; repo: string }, commit: string): Promise<{ verdict: ReleaseVerdict; settled: boolean }> {
    return tokenCaller(account)(async (token) => {
      const headers = { authorization: `token ${token}` };
      const pulls = (await req('GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls', { ...gh, commit_sha: commit, headers })).data as Pull[];
      const isMerge = (p: Pull | undefined): p is Pull => !!p && !!p.merged_at && p.merge_commit_sha === commit;
      let pr = pulls.find(isMerge);
      if (!pr) {
        // GitHub's commit-to-pull-request answer lags a merge, and can name only a later pull request that holds the
        // commit (a promotion). A two-parent "Merge pull request #N" commit is checked against pull N itself (issue #913).
        const c = (await req('GET /repos/{owner}/{repo}/commits/{ref}', { ...gh, ref: commit, headers })).data as { commit: { message: string }; parents: unknown[] };
        const n = MERGE_MESSAGE.exec(c.commit.message)?.[1];
        if (n && c.parents.length === 2) {
          const named = (await req('GET /repos/{owner}/{repo}/pulls/{pull_number}', { ...gh, pull_number: Number(n), headers })).data as Pull;
          if (isMerge(named)) pr = named;
        }
      }
      // Not settled: an answer that lags may name the pull request later.
      if (!pr) return { verdict: { passed: false, reason: `${short(commit)} is not the merge of a pull request` }, settled: false };
      const runs = (await req('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', { ...gh, ref: pr.head.sha, per_page: 100, headers })).data as { check_runs: Run[] };
      return checksVerdict({ number: pr.number, url: pr.html_url }, runs.check_runs);
    }, (err) => (err instanceof Error ? err : new Error(String(err))));
  }

  return {
    async verify(repo, commit) {
      const gh = githubRepoOf(repo);
      if (!gh) return { passed: false, reason: `the update repository is not on GitHub: the hopper cannot see that ${short(commit)} is a merged pull request with passing checks` };
      const key = `${gh.owner}/${gh.repo}@${commit}`;
      const now = o.clock.now().getTime();
      const was = known.get(key);
      if (was && (was.settled || (was.until !== undefined ? now < was.until : now - was.at < retryMs))) return was.verdict;
      const account = o.github();
      if ('problem' in account) return { passed: false, reason: `GitHub could not be asked about ${short(commit)}: ${account.problem}` };
      let answer: { verdict: ReleaseVerdict; settled: boolean; until?: number };
      try {
        answer = await ask(account, gh, commit);
      } catch (e) {
        const until = rateLimitedUntil(e, now);
        answer = until !== undefined
          ? { verdict: { passed: false, reason: `GitHub rate-limited the hopper: it asks about ${short(commit)} again at ${hhmm(until)} UTC` }, settled: false, until }
          : { verdict: { passed: false, reason: `GitHub could not be asked about ${short(commit)}: ${e instanceof Error ? e.message : String(e)}` }, settled: false };
      }
      known.set(key, { ...answer, at: now });
      return answer.verdict;
    },
  };
}
