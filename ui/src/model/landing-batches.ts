// Landing batches in the UI (issue #1073), pure: the line that says where one repository's batch runs stand, and the
// change a save sends.
import type { LandingBatchRepoView, LandingBatchSettings } from './wire.ts';

const short = (sha: string): string => sha.slice(0, 12);
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

/** Where a configured repository's batch runs stand: a problem, a batch run at work, or why none started and how the last ended. */
export function landingBatchLine(r: LandingBatchRepoView): string {
  if (r.problem) return `Cannot run: ${r.problem}`;
  const run = r.state.running;
  if (run) return `Batch run #${run.pullRequest} tests ${short(run.tip)} (${plural(run.merges.length, 'pull request')}).`;
  const last = r.state.last;
  const ended = !last ? '' : last.outcome === 'promoted'
    ? ` Last batch run #${last.pullRequest} moved ${r.config.tested} to ${short(last.tip)}.`
    : ` Last batch run #${last.pullRequest} failed: ${last.reason ?? 'no reason given'}.`;
  return `${r.why ? `Waiting: ${r.why}.` : 'Waiting for the next pass.'}${ended}`;
}

type RepoPatch = Partial<LandingBatchSettings['repos'][string]>;

/** The change from `from` to `to`, only what differs; undefined when nothing does. */
export function landingBatchPatch(from: LandingBatchSettings, to: LandingBatchSettings): { repos: Record<string, RepoPatch | null> } | undefined {
  const repos: Record<string, RepoPatch | null> = {};
  for (const repo of Object.keys(from.repos)) if (!to.repos[repo]) repos[repo] = null;
  for (const [repo, c] of Object.entries(to.repos)) {
    const was = from.repos[repo];
    if (!was) { repos[repo] = c; continue; }
    const diff: RepoPatch = {};
    if (c.tested !== was.tested) diff.tested = c.tested;
    if (c.everyMerges !== was.everyMerges) diff.everyMerges = c.everyMerges;
    if (c.everyMinutes !== was.everyMinutes) diff.everyMinutes = c.everyMinutes;
    if (Object.keys(diff).length > 0) repos[repo] = diff;
  }
  return Object.keys(repos).length > 0 ? { repos } : undefined;
}
