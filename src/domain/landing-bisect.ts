// A red batch (issue #1073 part 2, design.md "Landing batches"): when a batch run's checks fail, the hopper bisects
// within the batch. The batch's **points** are the landing branch's first-parent commits beyond the tested branch — a
// merge of each pull request, or a direct commit —, oldest first; the tip is known to fail and the tested branch to
// pass. Each bisect run tests the point in the middle, as a batch run does; the first point that fails is the
// **culprit**. The hopper reverts it from the landing branch (GitHub's revert of its pull request) and files a **fix
// issue**, so Intake takes it like any other work; then the batch with the culprit reverted runs again and promotes
// the rest. The rules and the text here; the runner `src/landing-batches/red.ts`. Pure.
import { maskAddresses, maskGitHubTokens, maskKeys, maskSecrets } from '../secrets/mask.ts';
import { BATCH_BRANCH_PREFIX } from './landing-batches.ts';

/** One point of a batch: a commit on the landing branch's first-parent line, and the pull request its merge names. */
export interface BatchPoint { sha: string; pullRequest?: number }

/** A failed check run: its name, and its id (a GitHub Actions job's, for its log) when GitHub gave one. */
export interface FailedCheck { name: string; id?: number }

/** One bisect run's result. `unknown`: no verdict (no check in time, merge conflicts), which ends the bisect. */
export interface BisectResult { index: number; sha: string; outcome: 'good' | 'bad' | 'unknown' }

/** A bisect at work within the batch whose run at `tip` failed. */
export interface Bisect {
  tip: string;
  tested: string;
  /** The pull request of the batch run that failed. */
  batch?: number;
  points: BatchPoint[];
  /** The newest point known to pass; -1: only the tested branch. */
  good: number;
  /** The oldest point known to fail; the tip at first. */
  bad: number;
  /** The checks that failed, per point that failed. */
  checks: Record<number, FailedCheck[]>;
  reason: string;
  startedAt: string;
  results: BisectResult[];
  running?: { index: number; sha: string; branch: string; pullRequest: number; url: string; startedAt: string };
  /** Per point, its bisect runs cut off (issue #2086): the point runs again up to BATCH_RERUNS times. */
  cutOff?: Record<number, number>;
}

/** The first point that fails, its revert and its fix issue. */
export interface Culprit {
  /** The tip of the batch run that failed. */
  tip: string;
  /** The pull request of the batch run that failed. */
  batch?: number;
  sha: string;
  pullRequest?: number;
  checks: FailedCheck[];
  reason: string;
  at: string;
  results: BisectResult[];
  revert?: { pullRequest: number; url: string; state: 'open' | 'merged' };
  /** Why the culprit was not reverted: a direct commit, GitHub refused, the revert closed without a merge. */
  revertProblem?: string;
  fix?: { issue: number; url: string };
}

const short = (sha: string): string => sha.slice(0, 12);
const MERGE = /^Merge pull request #(\d+) /;

/** The batch's points: from `tip` back along first parents while the commit is in the batch, oldest first. */
export function batchPoints(commits: readonly { sha: string; parents: readonly string[]; message: string }[], tip: string): BatchPoint[] {
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const out: BatchPoint[] = [];
  for (let c = bySha.get(tip); c; c = bySha.get(c.parents[0] ?? '')) {
    const n = MERGE.exec(c.message);
    out.push(n ? { sha: c.sha, pullRequest: Number(n[1]) } : { sha: c.sha });
    if (out.length > commits.length) break;
  }
  return out.reverse();
}

/** The next step: a bisect run of the middle point, or the culprit once one point is left between the two ends. */
export function bisectNext(b: Pick<Bisect, 'good' | 'bad'>): { kind: 'test'; index: number } | { kind: 'culprit'; index: number } {
  if (b.bad - b.good <= 1) return { kind: 'culprit', index: b.bad };
  return { kind: 'test', index: Math.ceil((b.good + b.bad) / 2) };
}

/** A bisect run's branch, under the batch prefix, so no job pushes to it. */
export const bisectBranch = (sha: string): string => `${BATCH_BRANCH_PREFIX}bisect-${short(sha)}`;

export const bisectTitle = (b: { tested: string; sha: string; tip: string }): string =>
  `Bisect run: ${short(b.sha)} into ${b.tested} (batch at ${short(b.tip)})`;

export function bisectBody(b: { landing: string; tested: string; sha: string; tip: string; pullRequest?: number }): string {
  return [
    `A bisect run of the landing branch \`${b.landing}\` at \`${short(b.sha)}\`${b.pullRequest ? ` (the merge of #${b.pullRequest})` : ''}.`,
    `The batch run at \`${short(b.tip)}\` failed. This run tells if the batch already failed at this point.`,
    `The hopper closes it when its checks end. It never merges it into \`${b.tested}\`. Do not merge it by hand.`,
  ].join('\n');
}

/** The issue a pull request's body closes or is part of. */
export function linkedIssue(body: string): number | undefined {
  const m = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|part of)\s+#(\d+)/i.exec(body);
  return m ? Number(m[1]) : undefined;
}

/** The revert's text: neutral, what it reverts and why. */
export function revertText(r: { landing: string; tested: string; tip: string; culprit: number; checks: readonly string[]; batch?: number }): { title: string; body: string } {
  return {
    title: `Revert #${r.culprit}: it fails the full test suite`,
    body: [
      `The batch run${r.batch !== undefined ? ` #${r.batch}` : ''} of \`${r.landing}\` at \`${short(r.tip)}\` failed: ${r.checks.join(', ') || 'checks failed'}.`,
      `A bisect within the batch found that the checks fail first at #${r.culprit}. This reverts it from \`${r.landing}\`,`,
      `so the rest of the batch can reach \`${r.tested}\`. The hopper filed an issue to make the change again with a fix.`,
    ].join('\n'),
  };
}

/** The last `lines` lines of a check's output, with secrets, keys and addresses masked. */
export function logTail(text: string, lines = 60): string {
  const tail = text.replace(/\r/g, '').trimEnd().split('\n').slice(-lines).join('\n');
  return maskAddresses(maskKeys(maskSecrets(maskGitHubTokens(tail))));
}

/** The fix issue's text: neutral — the culprit, its issue, the revert, each failing check with its output, the bisect. */
export function fixIssueText(f: {
  landing: string; tested: string; tip: string; sha: string; pullRequest?: number; issue?: number; batch?: number;
  revert: { pullRequest: number } | { problem: string };
  checks: readonly { name: string; log?: string }[];
  results: readonly BisectResult[];
}): { title: string; body: string } {
  const what = f.pullRequest ? `#${f.pullRequest}` : short(f.sha);
  const fence = (s: string): string => '```\n' + s.replace(/```/g, "'''") + '\n```';
  const outcome = { good: 'passed', bad: 'failed', unknown: 'no verdict' } as const;
  return {
    title: `Fix the full test suite after ${what}`,
    body: [
      `The batch run${f.batch !== undefined ? ` #${f.batch}` : ''} of \`${f.landing}\` at \`${short(f.tip)}\` into \`${f.tested}\` failed.`,
      `A bisect within the batch found the first change that fails: ${f.pullRequest ? `#${f.pullRequest} (\`${short(f.sha)}\`)` : `the commit \`${short(f.sha)}\``}${f.issue ? `, for #${f.issue}` : ''}.`,
      '',
      'revert' in f && 'pullRequest' in f.revert
        ? `The hopper reverts it from \`${f.landing}\` with #${f.revert.pullRequest}, so the rest of the batch can reach \`${f.tested}\`.`
        : `The hopper did not revert it: ${(f.revert as { problem: string }).problem}.`,
      '',
      `Make the change of ${what} again, with the failing tests fixed. The pull request for it lands on \`${f.landing}\`.`,
      '',
      '## Failing checks',
      ...(f.checks.length === 0 ? ['- (no check names)'] : f.checks.flatMap((c) => [
        '', `### ${c.name}`, '', c.log ? fence(c.log) : '(no output could be read)',
      ])),
      '',
      '## Bisect',
      ...(f.results.length === 0 ? ['- No bisect run: the batch had one change.'] : f.results.map((r) => `- ${short(r.sha)}: ${outcome[r.outcome]}`)),
    ].join('\n'),
  };
}
