// The issues a source did not take, grouped by why (issue #798): its not-taken group, in the order the UI lists them —
// request cards first, as they wait for a person —, with a count per group. The issues on the backburner are counted apart
// (issue #808), so the nav and the Queue always show how many are kept out. Taken, partly done and pull-request-waits issues
// passed intake (issue #1035): their state is job progress, on Jobs, and Intake only counts them. A request a person
// declined (issue #1035) waits for nobody: Intake counts it apart.
import type { IntakeOutcome, NotTakenGroup } from '../../../src/domain/intake.ts';
import type { DeclineChoice, IntakeDeclineDefaults, JobStatus, SourceStatus } from './wire.ts';

/** The decline choices (issue #1710), in the order the confirm step lists them. */
export const DECLINE_CHOICES: readonly DeclineChoice[] = ['close', 'open'];
/** The daemon's default when no admin set one: Leave it open for a request card, Close the issue for a reopened card. */
export const DEFAULT_DECLINE: IntakeDeclineDefaults = { request: 'open', reopened: 'close' };
/** Each choice as the confirm step names it. */
export const DECLINE_LABEL: Record<DeclineChoice, string> = { close: 'Close the issue', open: 'Leave it open' };
/** What each choice does on GitHub, said before the click. */
export const DECLINE_EFFECT: Record<DeclineChoice, string> = {
  close: 'The hopper closes the issue as not planned, removes its hopper labels and posts a short comment that says so.',
  open: 'The issue stays open. The hopper removes the hopper label, so no hopper queues it, and posts a short comment that says so.',
};
/** What a decline did, on its row once the card is gone. */
export const DECLINED_ROW: Record<DeclineChoice, string> = { close: 'declined: issue closed on GitHub', open: 'declined: issue left open without the hopper label' };
/** What a decline did, on the card after it. */
export const DECLINED_DONE: Record<DeclineChoice, string> = {
  close: 'Declined: no job. The hopper closes the issue as not planned and comments on it. Add the hopper label again to queue it',
  open: 'Declined: no job. The issue stays open without the hopper label, with a comment. Add the hopper label again to queue it',
};

export type IntakeGroupKind = NotTakenGroup | 'taken';

/** Each group's heading. A Record of every group, so a group added in the daemon and not here fails the UI typecheck. */
export const INTAKE_GROUP_LABEL: Record<IntakeGroupKind, string> = {
  request: 'Needs approval', 'not-assigned': 'Not assigned to you', backburner: 'Later',
  'pr-waiting': 'Pull request waits for review', 'partly-done': 'Partly done', declined: 'Declined', other: 'Other reasons', taken: 'Taken',
};
const ORDER = Object.keys(INTAKE_GROUP_LABEL) as IntakeGroupKind[];

export interface IntakeGroup {
  kind: IntakeGroupKind;
  items: IntakeOutcome[];
  /** What its heading counts: the request cards still waiting for approval in Needs approval, else every item. */
  count: number;
}

/** The group of one outcome: taken, or the group the daemon named. */
export const groupOf = (x: IntakeOutcome): IntakeGroupKind => (x.reason === undefined ? 'taken' : x.group ?? 'other');

/** The groups of the issues that passed intake (issue #1035): job progress, shown on Jobs. */
const IN_PROGRESS: ReadonlySet<IntakeGroupKind> = new Set(['taken', 'pr-waiting', 'partly-done']);
/** An outcome that passed intake: taken, partly done, or its pull request waits for review. */
export const inProgress = (x: IntakeOutcome): boolean => IN_PROGRESS.has(groupOf(x));
/** A request card a person declined (issue #1035). */
export const declined = (x: IntakeOutcome): boolean => groupOf(x) === 'declined';
/** An outcome waiting on an intake decision: not in progress, not declined. */
export const waiting = (x: IntakeOutcome): boolean => !inProgress(x) && !declined(x);

/** The non-empty groups of the outcomes waiting on an intake decision, in order (issue #1035). An item in `kept` (a request
 *  card a person approves or approved from this page, issue #811) stays in Needs approval, where it was, whatever the sync
 *  made of it: the list does not move under the person who acted. */
export function intakeGroups(items: IntakeOutcome[], kept?: ReadonlySet<string>): IntakeGroup[] {
  const of = (x: IntakeOutcome): IntakeGroupKind => (kept?.has(x.key) ? 'request' : groupOf(x));
  return ORDER.filter((k) => !IN_PROGRESS.has(k) && k !== 'declined')
    .map((kind) => {
      const listed = items.filter((x) => of(x) === kind);
      return { kind, items: listed, count: kind === 'request' ? listed.filter((x) => x.action === 'approve').length : listed.length };
    })
    .filter((g) => g.items.length > 0);
}

/** A source's intake outcomes, or none when it lists none. */
export const intakeOf = (s: SourceStatus): IntakeOutcome[] => (Array.isArray(s.detail?.intake) ? s.detail.intake as IntakeOutcome[] : []);

/**
 * Why a source lists fewer issues than it should (issue #1125): it is paused (it lists none), its last sync failed, or
 * GitHub did not answer for some of its job repositories (their issues are not listed). Empty: nothing to say.
 */
export interface IntakeTrouble { paused?: string; error?: string; repoErrors: [repo: string, error: string][] }
export function intakeTrouble(s: SourceStatus): IntakeTrouble {
  const d = s.detail ?? {};
  const repoErrors = d.repoErrors && typeof d.repoErrors === 'object' ? Object.entries(d.repoErrors as Record<string, unknown>).map(([r, e]): [string, string] => [r, String(e)]) : [];
  return {
    ...(typeof d.paused === 'string' ? { paused: d.paused } : {}),
    ...(s.state === 'error' && s.lastError ? { error: s.lastError } : {}),
    repoErrors,
  };
}
/**
 * A source Intake shows: one that lists issues, or one that is paused, so Intake says why it lists none; and the GitHub
 * connection's source while it cannot run (issue #1377), with its error, never left out.
 */
export const inIntake = (s: SourceStatus): boolean => Array.isArray(s.detail?.intake) || typeof s.detail?.paused === 'string'
  || (s.kind === 'github-account' && s.state === 'error');

/** The issues on the backburner across the sources (issue #808): Intake's second badge, and the Queue's link. */
export const onTheBackburner = (sources: SourceStatus[]): number => sources.reduce((n, s) => n + intakeOf(s).filter((x) => groupOf(x) === 'backburner').length, 0);

/** An issue's number from its key (a GitHub issue URL), or undefined for another kind of item (issue #808). */
export const issueNumber = (key: string): number | undefined => { const m = /\/issues\/(\d+)$/.exec(key); return m ? Number(m[1]) : undefined; };

/**
 * The request cards waiting for approval across the sources: the Intake badge and Needs you's Intake row. The count each
 * source's Needs approval heading shows, by the same rule (intakeGroups), so the badge and the page never disagree
 * (issue #1193): a reopened card (issue #1126) counts as soon as the page shows it.
 */
export const requestsWaiting = (sources: readonly SourceStatus[]): number =>
  sources.reduce((n, s) => n + (intakeGroups(intakeOf(s)).find((g) => g.kind === 'request')?.count ?? 0), 0);

/**
 * The labelled issues not assigned to the user across the sources (issue #1614): no job starts on one until a person
 * assigns it, and nothing on the issue says so. With the request cards, the Intake badge and Needs you's Intake row.
 */
export const notAssignedWaiting = (sources: readonly SourceStatus[]): number =>
  sources.reduce((n, s) => n + intakeOf(s).filter((x) => groupOf(x) === 'not-assigned').length, 0);

const ENDED: readonly JobStatus[] = ['finished', 'failed', 'cancelled', 'rejected'];
/** A taken item's job has ended since the sync that took it: the next sync says what became of the issue. */
export const jobEnded = (status: JobStatus | undefined): boolean => status !== undefined && ENDED.includes(status);

/** The owner/repo of an outcome (issue #1463): as the source named it, else from its key (a GitHub issue URL). */
export const repoOf = (x: IntakeOutcome): string | undefined => x.repo ?? /^https:\/\/github\.com\/([^/]+\/[^/]+)\//.exec(x.key)?.[1];

/** An outcome's reference, owner/repo#number (issue #1463); undefined for an item with no issue number. */
export function intakeRef(x: IntakeOutcome): string | undefined {
  const n = issueNumber(x.key);
  if (n === undefined) return undefined;
  const repo = repoOf(x);
  return repo ? `${repo}#${n}` : `#${n}`;
}

/**
 * The repositories of the outcomes, in name order, with how many each has, and the name a filter shows for each
 * (issue #1463): the repository's name alone, or owner/repo when two owners have a repository of that name.
 */
export function reposOf(items: readonly IntakeOutcome[]): { repo: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const x of items) { const r = repoOf(x); if (r) counts.set(r, (counts.get(r) ?? 0) + 1); }
  const name = (r: string) => r.split('/').pop()!;
  const repos = [...counts.keys()].sort();
  return repos.map((repo) => ({
    repo, count: counts.get(repo)!,
    label: repos.filter((r) => name(r) === name(repo)).length > 1 ? repo : name(repo),
  }));
}
