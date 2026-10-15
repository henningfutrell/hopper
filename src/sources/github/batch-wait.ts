// Waits on its batch, read from GitHub (issue #1337, design.md "Waits on its batch, read from GitHub"): an open issue
// whose work merged into the landing branch and has not reached the tested branch (the default branch) yet. GitHub closes
// an issue only on a merge into the default branch, so the issue stays open until its batch run merges, and its timeline
// may show no cross-reference of the merge. Read from GitHub, not from the work-item ledger, so the rule holds when the
// ledger missed the merge: one rule for the done-check (`notComplete`) and Intake (`waitingOnBatch`); the ledger's own rule
// is `awaitsBatch` (issue #1175). It is not "no pull request", not a new request, and never a run again; the batch run's
// merge closes the issue, and the item is done with no more action.
//
// It waits: an open batch run's pull request closes the issue (its closing lines, issue #1175), or names a pull request
// merged into the landing branch that closes it; or such a merge came after the newest open batch run was opened (the next
// batch run takes it) and within BATCH_WAIT_MS, as the batch runner names a merge within its interval. A merge older
// than that, which no open batch run names, went out with an earlier batch run: the issue stays open for another reason
// (a person reopened it). `since` (the done-check): a merge at or after it is the job's own work, at any age.
import { closingReferences } from '../../domain/cross-references.ts';
import { DONE_OPEN } from './discover.ts';
import { BATCH_BRANCH_PREFIX } from '../../domain/landing-batches.ts';
import type { IntakeOutcome } from '../../domain/intake.ts';
import type { GitHubApi, GitHubIssue } from './api.ts';
import { AWAITS_BATCH } from './origin.ts';

/** How long a merge into the landing branch no open batch run names counts as waiting for one: three batch intervals. */
export const BATCH_WAIT_MS = 3 * 60 * 60_000;

type Reads = Pick<GitHubApi, 'openPullRequests' | 'mergedPullRequestsInto'>;

const closes = (body: string, repo: string, n: number): boolean =>
  closingReferences(body, repo).some((r) => r.number === n && r.repo.toLowerCase() === repo.toLowerCase());

/** A batch run's text lists each job pull request it carries as `- #N` (`batchBody`). */
const carries = (body: string, pullRequest: number): boolean => new RegExp(`^- #${pullRequest}(?!\\d)`, 'm').test(body);

/** Whether issue `n` of `repo` waits on its batch run from landing branch `landing`. `now`: ms. An error asking GitHub throws. */
export async function waitsOnBatch(api: Reads, repo: string, landing: string, n: number, now: number, since?: string): Promise<boolean> {
  const batches = (await api.openPullRequests(repo)).filter((p) => p.headRef.startsWith(BATCH_BRANCH_PREFIX));
  if (batches.some((b) => closes(b.body, repo, n))) return true;
  const merges = (await api.mergedPullRequestsInto(repo, landing)).filter((p) => closes(p.body, repo, n));
  const newest = Math.max(0, ...batches.map((b) => Date.parse(b.createdAt)));
  return merges.some((p) => {
    const at = Date.parse(p.mergedAt);
    return (since !== undefined && at >= Date.parse(since)) || batches.some((b) => carries(b.body, p.number))
      || (at > newest && now - at <= BATCH_WAIT_MS);
  });
}

/**
 * Intake's outcomes with each issue that waits on its batch said so (issue #1337): `done, but the issue is still open`,
 * and the issues `taken` it would offer or run again (no job here, or one that ended). Each is in the pull request waiting
 * group with no action, so no request card and no reopened card; `waiting`, their URLs, which it neither offers nor runs.
 * A repository with no landing branch has none. A read GitHub refuses leaves the issue as it was.
 */
export async function waitingOnBatch(api: Reads, landing: ((repo: string) => string | undefined) | undefined, now: number,
  outcomes: readonly IntakeOutcome[], seen: readonly GitHubIssue[], taken: readonly GitHubIssue[]): Promise<{ outcomes: IntakeOutcome[]; waiting: Set<string> }> {
  const found = new Set<string>();
  const doneOpen = new Set(outcomes.filter((x) => x.reason === DONE_OPEN).map((x) => x.key));
  for (const i of [...seen.filter((x) => doneOpen.has(x.url)), ...taken]) {
    const branch = landing?.(i.repo);
    if (branch === undefined || found.has(i.url)) continue;
    try {
      if (await waitsOnBatch(api, i.repo, branch, i.number, now)) found.add(i.url);
    } catch (err) {
      console.warn(`hopper: whether ${i.url} awaits its batch run could not be read: ${(err as Error).message}`);
    }
  }
  const said = ({ action: _a, ...x }: IntakeOutcome): IntakeOutcome => ({ ...x, reason: AWAITS_BATCH, group: 'pr-waiting' });
  return { outcomes: outcomes.map((x) => (found.has(x.key) ? said(x) : x)), waiting: found };
}
