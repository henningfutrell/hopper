// The issues a source did not take, grouped by why (issue #798): its not-taken group, in the order the UI lists them —
// request cards first, as they wait for a person —, with a count per group. The issues on the backburner are counted apart
// (issue #808), so the nav and the Queue always show how many are kept out. Taken, partly done and pull-request-waits issues
// passed intake (issue #1035): their state is job progress, on Jobs, and Intake only counts them. A request a person
// declined (issue #1035) waits for nobody: Intake counts it apart.
import type { IntakeOutcome, NotTakenGroup } from '../../../src/domain/intake.ts';
import type { JobStatus, SourceStatus } from './wire';

export type IntakeGroupKind = NotTakenGroup | 'taken';

/** Each group's heading. A Record of every group, so a group added in the daemon and not here fails the UI typecheck. */
export const INTAKE_GROUP_LABEL: Record<IntakeGroupKind, string> = {
  request: 'Needs approval', 'not-assigned': 'Not assigned to you', backburner: 'On the backburner',
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

/** The issues on the backburner across the sources (issue #808): Intake's second badge, and the Queue's link. */
export const onTheBackburner = (sources: SourceStatus[]): number => sources.reduce((n, s) => n + intakeOf(s).filter((x) => groupOf(x) === 'backburner').length, 0);

/** An issue's number from its key (a GitHub issue URL), or undefined for another kind of item (issue #808). */
export const issueNumber = (key: string): number | undefined => { const m = /\/issues\/(\d+)$/.exec(key); return m ? Number(m[1]) : undefined; };

/** The request cards waiting for approval across the sources: the Intake badge. */
export const requestsWaiting = (sources: SourceStatus[]): number => sources.reduce((n, s) => n + intakeOf(s).filter((x) => x.action === 'approve').length, 0);

const ENDED: readonly JobStatus[] = ['finished', 'failed', 'cancelled', 'rejected'];
/** A taken item's job has ended since the sync that took it: the next sync says what became of the issue. */
export const jobEnded = (status: JobStatus | undefined): boolean => status !== undefined && ENDED.includes(status);
