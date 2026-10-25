// The canary (issue #1073 part 5, design.md "Landing batches: the canary"): `beta` → `stable` through a **canary**. A
// maintainer promotes a commit of `beta` to the `canary` branch (`scripts/promote.sh canary`). The installs that take
// stable releases early (the **canary subset**: Settings → Version, each install's own choice) follow `canary` while it
// is ahead of `stable`, so a stable release reaches them before every other install. The batch runner watches the
// candidate for the **canary window** (`canaryHours`): a bug report that names it holds it, and one issue is filed with
// the hopper label, so Intake takes it; the window passed with no report, `stable` moves to it. Each step is an event
// (`landing_batch.canary_*`); the state here, the runner `src/landing-batches/canary.ts`. Pure.

/** The branch a stable candidate waits on, and the branch it goes to: the hopper's update channels (src/domain/update.ts). */
export const CANARY_BRANCH = 'canary';
export const BETA_BRANCH = 'beta';
export const STABLE_BRANCH = 'stable';
export const DEFAULT_CANARY_HOURS = 24;

/** The newest candidate on the canary branch: watched, held with why, or promoted to stable. */
export interface Canary {
  tip: string;
  state: 'running' | 'held' | 'promoted';
  /** When the window started: when the runner first saw the candidate. */
  startedAt: string;
  /** The bug reports that held it. */
  reports: number[];
  reason?: string;
  /** The issue filed for a held candidate. */
  issue?: { issue: number; url: string };
  at: string;
}

/** The part of a repository's state that the canary keeps. */
export interface CanaryState { canary?: Canary }

/** A canary event onto the state. An event of another candidate than the newest changes nothing. */
export function reduceCanary(s: CanaryState, type: string, d: Record<string, unknown>, at: string): void {
  const tip = String(d.tip ?? '');
  if (type === 'landing_batch.canary_started') {
    s.canary = { tip, state: 'running', startedAt: at, reports: [], at };
    return;
  }
  const c = s.canary?.tip === tip ? s.canary : undefined;
  if (!c) return;
  if (type === 'landing_batch.canary_held') {
    Object.assign(c, { state: 'held', reports: (d.reports as number[] | undefined) ?? [], reason: String(d.reason ?? ''), at });
  } else if (type === 'landing_batch.canary_promoted') {
    Object.assign(c, { state: 'promoted', at });
  } else if (type === 'landing_batch.canary_issue_filed') {
    c.issue = { issue: Number(d.issue), url: String(d.url) };
  }
}

const short = (sha: string): string => sha.slice(0, 12);

/** What the canary branch has that stable lacks: a new candidate starts, the one at work is watched, else nothing. */
export function canaryNext(c: Canary | undefined, f: { tip: string; aheadBy: number }):
  { kind: 'idle'; why: string } | { kind: 'start'; why: string } | { kind: 'watch' } {
  if (f.aheadBy <= 0) return { kind: 'idle', why: `nothing new on ${CANARY_BRANCH} beyond ${STABLE_BRANCH}` };
  if (c?.tip !== f.tip) return { kind: 'start', why: `a new candidate ${short(f.tip)} on ${CANARY_BRANCH}` };
  if (c.state === 'held') return { kind: 'idle', why: `the canary ${short(c.tip)} is held: ${c.reason ?? ''}` };
  if (c.state === 'promoted') return { kind: 'idle', why: `the canary ${short(c.tip)} went to ${STABLE_BRANCH}` };
  return { kind: 'watch' };
}

/** The candidate at work, with the bug reports that name it: held, promoted once its window passed, or it waits. */
export function canaryVerdict(c: Canary, reports: readonly number[], hours: number, now: Date):
  { kind: 'hold'; reason: string } | { kind: 'promote'; why: string } | { kind: 'wait'; why: string } {
  if (reports.length > 0) return { kind: 'hold', reason: `bug reports name it: ${reports.map((n) => `#${n}`).join(', ')}` };
  const left = hours - Math.floor((now.getTime() - Date.parse(c.startedAt)) / 3_600_000);
  if (left <= 0) return { kind: 'promote', why: `no bug report named it in ${hours} hours` };
  return { kind: 'wait', why: `the canary ${short(c.tip)} runs ${left} more hour${left === 1 ? '' : 's'} with no bug report` };
}

/** The issue for a held candidate: which reports hold it, and what to do. Neutral; it names no person. */
export function canaryIssueText(c: { tip: string; reports: readonly number[]; hours: number }): { title: string; body: string } {
  return {
    title: `The canary ${short(c.tip)} is held: bug reports name it`,
    body: [
      `The stable candidate \`${short(c.tip)}\` on the \`${CANARY_BRANCH}\` branch is held. Bug reports name it within its`,
      `canary window of ${c.hours} hours, so it does not go to \`${STABLE_BRANCH}\`:`,
      '',
      ...c.reports.map((n) => `- #${n}`),
      '',
      'To continue:',
      '',
      '1. Read each report. Fix what the candidate broke on the default branch, as for any change.',
      `2. Promote the fix up the channels to \`${CANARY_BRANCH}\`. A new candidate starts a new canary window.`,
      `3. When the reports are not about the candidate, a maintainer can move it to \`${STABLE_BRANCH}\` by hand:`,
      `   \`bash scripts/promote.sh stable ${c.tip}\``,
    ].join('\n'),
  };
}
