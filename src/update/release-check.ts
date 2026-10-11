// The release check (issue #652, design.md "Self-update"): the hopper updates only to a commit that is the merge of a
// pull request whose checks passed. A push straight to a channel's branch, a pull request with no checks, a check that
// failed or has not finished, and a commit GitHub cannot be asked about are all held. Asked of GitHub's REST API with
// no token: the update repository is public, and the updater runs for the instance, not for a user's connection.
import type { Clock, ReleaseCheck, ReleaseVerdict } from '../domain/ports.ts';
import { makeRequest } from '../sources/github/app/http.ts';

/** How long an answer that can still change (checks running, failed, none) is kept before GitHub is asked again. */
export const RELEASE_RETRY_MS = 5 * 60_000;
/** A check run's conclusions that count as passed; at least one must be `success`. */
const PASSED = new Set(['success', 'neutral', 'skipped']);
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

export function createReleaseCheck(o: { apiUrl: string; clock: Clock; retryMs?: number }): ReleaseCheck {
  const req = makeRequest(o.apiUrl);
  const retryMs = o.retryMs ?? RELEASE_RETRY_MS;
  // A settled answer never changes; another is asked again once it is `retryMs` old (60 unauthenticated asks an hour).
  const known = new Map<string, { verdict: ReleaseVerdict; settled: boolean; at: number }>();

  async function ask(gh: { owner: string; repo: string }, commit: string): Promise<{ verdict: ReleaseVerdict; settled: boolean }> {
    const pulls = (await req('GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls', { ...gh, commit_sha: commit })).data as Pull[];
    const pr = pulls.find((p) => p.merged_at && p.merge_commit_sha === commit);
    if (!pr) return { verdict: { passed: false, reason: `${short(commit)} is not the merge of a pull request` }, settled: true };
    const runs = (await req('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', { ...gh, ref: pr.head.sha, per_page: 100 })).data as { check_runs: Run[] };
    return checksVerdict({ number: pr.number, url: pr.html_url }, runs.check_runs);
  }

  return {
    async verify(repo, commit) {
      const gh = githubRepoOf(repo);
      if (!gh) return { passed: false, reason: `the update repository is not on GitHub: the hopper cannot see that ${short(commit)} is a merged pull request with passing checks` };
      const key = `${gh.owner}/${gh.repo}@${commit}`;
      const now = o.clock.now().getTime();
      const was = known.get(key);
      if (was && (was.settled || now - was.at < retryMs)) return was.verdict;
      let answer: { verdict: ReleaseVerdict; settled: boolean };
      try {
        answer = await ask(gh, commit);
      } catch (e) {
        answer = { verdict: { passed: false, reason: `GitHub could not be asked about ${short(commit)}: ${e instanceof Error ? e.message : String(e)}` }, settled: false };
      }
      known.set(key, { ...answer, at: now });
      return answer.verdict;
    },
  };
}
