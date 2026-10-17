// Merge conflicts between the landing branch and the tested branch (issue #1073 part 4, design.md "Landing batches"). A
// batch run with merge conflicts says the tested branch has a change the landing branch lacks (a fix pushed to it, a
// pull request merged into it), and every later batch run has the same conflicts. So the hopper makes a **back-merge**:
// the tested branch merged into a branch at the landing tip by GitHub's own merge, and a pull request of it into the
// landing branch, which the hopper merges; the next batch run starts at once. A real conflict, which GitHub cannot merge,
// files one issue with the hopper label, so Intake takes it. The state and the text here; the runner
// `src/landing-batches/back-merge.ts`. Pure.
import { BATCH_BRANCH_PREFIX } from './landing-batches.ts';

/**
 * The newest back-merge: due (recorded with the batch run's failure, before any GitHub call, issue #1589), open (its pull
 * request into the landing branch), merged, or failed with why.
 */
export interface BackMerge {
  /** The landing tip whose batch run had the merge conflicts. */
  tip: string;
  state: 'due' | 'open' | 'merged' | 'failed';
  /** The pull request of the batch run with the merge conflicts. */
  batch?: number;
  branch?: string;
  pullRequest?: number;
  url?: string;
  /** Failed for a real conflict: an issue is filed for it. */
  conflict?: boolean;
  reason?: string;
  at: string;
}

/** The issue filed for a real conflict. It stays until a back-merge or a batch run is promoted. */
export interface BackMergeIssue { tip: string; issue: number; url: string }

/** The part of a repository's state that back-merges keep. */
export interface BackMergeState {
  backMerge?: BackMerge;
  backMergeIssue?: BackMergeIssue;
  /** A back-merge merged since the newest batch run started: the next one starts at once. */
  backMergedSinceRun?: boolean;
}

/** A back-merge's events onto the state. */
export function reduceBackMerge(s: BackMergeState, type: string, d: Record<string, unknown>, at: string): void {
  const tip = String(d.tip ?? '');
  const batch = typeof d.batch === 'number' ? { batch: d.batch } : {};
  const pr = typeof d.pullRequest === 'number' ? { pullRequest: d.pullRequest, url: String(d.url) } : {};
  if (type === 'landing_batch.back_merge_opened') {
    s.backMerge = { tip, state: 'open', ...batch, branch: String(d.branch), ...pr, at };
  } else if (type === 'landing_batch.back_merged' && s.backMerge?.tip === tip) {
    s.backMerge = { ...s.backMerge, state: 'merged', at };
    s.backMergedSinceRun = true;
    delete s.backMergeIssue;
  } else if (type === 'landing_batch.back_merge_failed') {
    s.backMerge = { ...(s.backMerge?.tip === tip ? s.backMerge : {}), tip, state: 'failed', ...batch, ...pr, conflict: d.conflict === true, reason: String(d.reason ?? ''), at };
  } else if (type === 'landing_batch.back_merge_issue_filed') {
    s.backMergeIssue = { tip, issue: Number(d.issue), url: String(d.url) };
  }
}

const short = (sha: string): string => sha.slice(0, 12);

/** A back-merge's branch: under the batch prefix, so no job pushes to it, named by the landing tip. */
export const backMergeBranch = (tip: string): string => `${BATCH_BRANCH_PREFIX}back-merge-${short(tip)}`;

interface BackMergeFacts { landing: string; tested: string; tip: string; batch?: number }

export const backMergeTitle = (b: BackMergeFacts): string => `Merge ${b.tested} into ${b.landing} at ${short(b.tip)}`;

const batchRun = (b: BackMergeFacts): string => `${b.batch !== undefined ? `The batch run #${b.batch}` : 'A batch run'} of \`${b.landing}\` at \`${short(b.tip)}\``;

/** The back-merge's pull request text: neutral, why it exists and what happens to it. */
export function backMergeBody(b: BackMergeFacts): string {
  return [
    `${batchRun(b)} has merge conflicts with the tested branch \`${b.tested}\`: \`${b.tested}\` has changes that`,
    `\`${b.landing}\` lacks. This pull request merges \`${b.tested}\` into \`${b.landing}\`. The hopper merges it when GitHub`,
    'lets it, and the next batch run starts at once. Do not merge it by hand.',
  ].join('\n');
}

/** The issue for a real conflict: what blocks the batch runs, and what to do. Neutral; it names no person. */
export function backMergeIssueText(b: BackMergeFacts): { title: string; body: string } {
  return {
    title: `Resolve the merge conflicts of ${b.tested} with ${b.landing}`,
    body: [
      `${batchRun(b)} has merge conflicts with the tested branch \`${b.tested}\`: \`${b.tested}\` has changes that`,
      `\`${b.landing}\` lacks, and they conflict with \`${b.landing}\`. The hopper could not merge \`${b.tested}\` into`,
      `\`${b.landing}\` by itself. Until this is resolved, every batch run has the same conflicts, and \`${b.tested}\` does not move.`,
      '',
      'To resolve it:',
      '',
      `1. Make a branch of \`${b.landing}\`.`,
      `2. Merge \`${b.tested}\` into it, and resolve each conflict. Keep the intent of both sides.`,
      `3. Run the checks, and open a pull request into \`${b.landing}\`.`,
    ].join('\n'),
  };
}
