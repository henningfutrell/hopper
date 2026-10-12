// Needs you (issue #897): the one inbox of every decision that waits on a person. One row per kind, in a fixed order, each
// with its count and a link to the page that is its one home; the nav badge is the total, marked when a high-priority job
// waits (#535). Parked jobs wait to be picked up, not on a decision: Parked keeps its own quiet badge, and has no row here.
// Pull requests counts the ones the hopper gave up on (issue #927), each with why: one with merge conflicts or failing checks
// the hopper tends itself, and is no decision.
// A machine's join takes no approval (a join code joins it at once); a machine whose box template waits counts in Access requests.
import type { SectionKind } from './wire.ts';

export const NEEDS_YOU_KINDS = ['intake', 'access', 'plans', 'questions', 'proposals', 'research', 'logins', 'failures', 'pull-requests', 'sorting'] as const;
export type NeedsYouKind = (typeof NEEDS_YOU_KINDS)[number];

export interface NeedsYouCounts {
  /** Request cards that wait for approval, across the sources. */
  intake: number;
  /** Credential requests, vault grant asks and templates that wait for approval. */
  access: number;
  /** Infra plans that wait for a person to approve them. */
  plans: number;
  /** The open pull requests the hopper gave up on (issue #927), one line each, with why. */
  gaveUp: readonly string[];
  /** Jobs that wait on the pre-sort. */
  sorting: number;
  sections: Readonly<Record<SectionKind, { n: number; high: number }>>;
}

export interface NeedsYouRow {
  kind: NeedsYouKind; label: string; href: string; n: number; high: number; what: string;
  /** One line per thing it counts, shown under the row (issue #927: why the hopper gave up on each pull request). */
  details?: readonly string[];
}

/** Each row's page and words: what it counts, said also when nothing waits, so a person knows the kind is there. */
const ROW: Record<NeedsYouKind, { label: string; href: string; what: string }> = {
  intake: { label: 'Intake', href: '#intake', what: 'issues from people outside your trusted actors, waiting for your approval' },
  access: { label: 'Access requests', href: '#access-requests', what: 'credentials, vault grants and box templates that jobs on boxes wait for' },
  plans: { label: 'Infra plans', href: '#infra', what: 'plans of infrastructure changes that wait for a person to approve them' },
  questions: { label: 'Questions', href: '#questions', what: 'questions jobs asked you' },
  proposals: { label: 'Proposals', href: '#proposals', what: 'proposals that wait for you to pick a path' },
  research: { label: 'Research', href: '#research', what: 'research reports that wait for you to accept or steer them' },
  logins: { label: 'Logins', href: '#logins', what: 'logins a job waits on, and connections that ended' },
  failures: { label: 'Failures', href: '#failures', what: 'open problems and jobs handed off to a person' },
  'pull-requests': { label: 'Pull requests', href: '#pull-requests', what: 'pull requests the hopper gave up on: fix them, or close them' },
  sorting: { label: 'Pre-sort', href: '#queue', what: 'jobs that wait on the pre-sort before a lane takes them' },
};

export function needsYouRows(c: NeedsYouCounts): NeedsYouRow[] {
  const count = (k: NeedsYouKind): { n: number; high: number; details?: readonly string[] } => {
    if (k === 'intake') return { n: c.intake, high: 0 };
    if (k === 'access') return { n: c.access, high: 0 };
    if (k === 'plans') return { n: c.plans, high: 0 };
    if (k === 'pull-requests') return { n: c.gaveUp.length, high: 0, ...(c.gaveUp.length ? { details: c.gaveUp } : {}) };
    if (k === 'sorting') return { n: c.sorting, high: 0 };
    return c.sections[k];
  };
  return NEEDS_YOU_KINDS.map((kind) => ({ kind, ...ROW[kind], ...count(kind) }));
}

/** The nav badge: every row's count, and the high-priority ones among them. */
export const needsYouTotal = (rows: readonly NeedsYouRow[]): { n: number; high: number } =>
  rows.reduce((t, r) => ({ n: t.n + r.n, high: t.high + r.high }), { n: 0, high: 0 });
