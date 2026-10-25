// Landing batches in the UI (issue #1073), pure: the line that says where one repository's batch runs stand, and the
// change a save sends; a red batch's bisect, culprit, revert and fix issue on that line, and its event lines; a back-merge
// after merge conflicts (part 4); the canary of a stable candidate (part 5).
import type { LandingBatchRepoView, LandingBatchSettings } from './wire.ts';

const short = (sha: string): string => sha.slice(0, 12);
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

/** Where a configured repository's batch runs stand: a problem, a batch run at work, or why none started and how the last ended. */
export function landingBatchLine(r: LandingBatchRepoView): string {
  if (r.problem) return `Cannot run: ${r.problem}`;
  const run = r.state.running;
  if (run) return `Batch run #${run.pullRequest} tests ${short(run.tip)} (${plural(run.merges.length, 'pull request')}).`;
  const b = r.state.bisect;
  if (b) {
    return `Bisecting the batch at ${short(b.tip)}: ${b.running
      ? `bisect run #${b.running.pullRequest} tests ${short(b.running.sha)}.`
      : `${plural(Math.max(0, b.bad - b.good - 1), 'change')} left to test.`}`;
  }
  const last = r.state.last;
  const ended = !last ? '' : last.outcome === 'promoted'
    ? ` Last batch run #${last.pullRequest} moved ${r.config.tested} to ${short(last.tip)}.`
    : ` Last batch run #${last.pullRequest} failed: ${last.reason ?? 'no reason given'}.`;
  const c = r.state.culprit;
  const culprit = !c ? '' : ` Culprit ${c.pullRequest !== undefined ? `#${c.pullRequest}` : short(c.sha)}: ${c.revertProblem !== undefined
    ? `not reverted (${c.revertProblem})`
    : c.revert ? `revert #${c.revert.pullRequest} ${c.revert.state}` : 'revert not open yet'}, ${c.fix ? `fix issue #${c.fix.issue}` : 'no fix issue yet'}.`;
  const m = r.state.backMerge;
  const backMerge = m?.state === 'open' && m.pullRequest !== undefined ? ` Merging ${r.config.tested} into the landing branch: #${m.pullRequest}.`
    : m?.state === 'failed' && m.conflict ? ` Merge conflicts with ${r.config.tested}: ${r.state.backMergeIssue ? `issue #${r.state.backMergeIssue.issue}` : 'no issue yet'}.` : '';
  return `${r.why ? `Waiting: ${r.why}.` : 'Waiting for the next pass.'}${culprit || ended}${backMerge}`;
}

/** A stuck landing pass (issue #1333): what failed, and for how long; undefined while it is not stuck. */
export function stuckLine(r: LandingBatchRepoView): string | undefined {
  if (!r.stuck) return undefined;
  return `The landing pass is stuck: it failed the same way on ${r.stuck.passes} passes in a row since ${r.stuck.since.slice(0, 16).replace('T', ' ')}Z: ${r.stuck.error}`;
}

/** Whether Restart batch has something to end or start: a batch run or a bisect at work, or a stuck pass. */
export const canRestart = (r: LandingBatchRepoView): boolean => r.state.running !== undefined || r.state.bisect !== undefined || r.stuck !== undefined;

/** Needs you's Landing row (issue #1333): one line per repository whose landing pass is stuck. */
export function stuckLandingLines(view: { repos: readonly LandingBatchRepoView[] } | undefined): string[] {
  return (view?.repos ?? []).flatMap((r) => (r.stuck ? [`${r.repo}: ${r.stuck.error} — Restart batch in Settings → Landing batches`] : []));
}

/** Where a repository's canary stands (part 5): none without a canary window; a problem, or why, and the newest candidate. */
export function canaryLine(r: LandingBatchRepoView): string | undefined {
  if (r.config.canaryHours === undefined) return undefined;
  if (r.canary?.problem) return `Canary: cannot run: ${r.canary.problem}`;
  const c = r.state.canary;
  const candidate = !c ? '' : c.state === 'held'
    ? ` Candidate ${short(c.tip)} held: ${c.reason ?? ''}, ${c.issue ? `issue #${c.issue.issue}` : 'no issue yet'}.`
    : c.state === 'promoted' ? ` Candidate ${short(c.tip)} went to stable.` : '';
  return `Canary: ${r.canary?.why ? `${r.canary.why}.` : 'waiting for the next pass.'}${candidate}`;
}

/** An event line for a red batch's step (issue #1073 part 2), a back-merge's (part 4) or the canary's (part 5). */
export function redBatchDetail(type: string, d: Record<string, unknown>): string {
  const at = `${String(d.repo)}: `;
  const sha = short(String(d.sha ?? ''));
  if (type === 'landing_batch.bisect_started') return `${at}bisecting the batch at ${short(String(d.tip))} (${plural(Array.isArray(d.points) ? d.points.length : 0, 'change')})`;
  if (type === 'landing_batch.bisect_run') return `${at}bisect run #${String(d.pullRequest)} tests ${sha}`;
  if (type === 'landing_batch.bisect_tested') return d.outcome === 'unknown' ? `${at}the bisect ended: ${String(d.reason)}` : `${at}${sha} ${d.outcome === 'good' ? 'passed' : 'failed'}`;
  if (type === 'landing_batch.culprit') return `${at}culprit ${typeof d.pullRequest === 'number' ? `#${d.pullRequest}` : sha}`;
  if (type === 'landing_batch.revert_opened') return `${at}revert #${String(d.pullRequest)} of #${String(d.culpritPullRequest)} opened`;
  if (type === 'landing_batch.reverted') return `${at}revert #${String(d.pullRequest)} merged`;
  if (type === 'landing_batch.revert_failed') return `${at}not reverted: ${String(d.reason)}`;
  if (type === 'landing_batch.fix_filed') return `${at}fix issue #${String(d.issue)} filed`;
  if (type === 'landing_batch.back_merge_opened') return `${at}merging ${String(d.tested)} into ${String(d.landing)}: #${String(d.pullRequest)}`;
  if (type === 'landing_batch.back_merged') return `${at}back-merge #${String(d.pullRequest)} merged`;
  if (type === 'landing_batch.back_merge_failed') return `${at}no back-merge: ${String(d.reason)}`;
  if (type === 'landing_batch.back_merge_issue_filed') return `${at}issue #${String(d.issue)} filed for the merge conflicts`;
  if (type === 'landing_batch.canary_started') return `${at}canary candidate ${short(String(d.tip))}, ${plural(Number(d.hours), 'hour')}`;
  if (type === 'landing_batch.canary_held') return `${at}canary ${short(String(d.tip))} held: ${String(d.reason)}`;
  if (type === 'landing_batch.canary_issue_filed') return `${at}issue #${String(d.issue)} filed for the held canary`;
  if (type === 'landing_batch.stuck') return `${at}the landing pass is stuck: ${String(d.error)}`;
  if (type === 'landing_batch.restarted') return `${at}the landing batch was restarted`;
  if (type === 'landing_batch.due') return `${at}a batch run of ${short(String(d.tip))} is due: ${String(d.why)}`;
  if (type === 'landing_batch.canary_promoted') return `${at}stable moved to ${short(String(d.tip))}`;
  if (type === 'landing_batch.beta_moved') return `${at}beta moved to ${short(String(d.tip))}`;
  return `${at}${type}`;
}

type RepoPatch = Partial<Omit<LandingBatchSettings['repos'][string], 'canaryHours'>> & { canaryHours?: number | null };

/** The change from `from` to `to`, only what differs; undefined when nothing does. */
export function landingBatchPatch(from: LandingBatchSettings, to: LandingBatchSettings): { repos: Record<string, RepoPatch | null> } | undefined {
  const repos: Record<string, RepoPatch | null> = {};
  for (const repo of Object.keys(from.repos)) if (!to.repos[repo]) repos[repo] = null;
  for (const [repo, c] of Object.entries(to.repos)) {
    const was = from.repos[repo];
    if (!was) { repos[repo] = c; continue; }
    const diff: RepoPatch = {};
    if (c.tested !== was.tested) diff.tested = c.tested;
    if ((c.landing ?? 'main') !== (was.landing ?? 'main')) diff.landing = c.landing ?? 'main';
    if (c.everyMerges !== was.everyMerges) diff.everyMerges = c.everyMerges;
    if (c.everyMinutes !== was.everyMinutes) diff.everyMinutes = c.everyMinutes;
    if (c.canaryHours !== was.canaryHours) diff.canaryHours = c.canaryHours ?? null;
    if (Object.keys(diff).length > 0) repos[repo] = diff;
  }
  return Object.keys(repos).length > 0 ? { repos } : undefined;
}
