// Needs you (issue #897): the one inbox of every decision that waits on a person. One row per kind, in a fixed order, each
// with its count and a link to the page that is its one home; the nav badge is the total, marked when a high-priority job
// waits (#535). Parked jobs wait to be picked up, not on a decision: Parked keeps its own quiet badge, and has no row here.
// Pull requests counts the ones the hopper gave up on (issue #927), each with why: one with merge conflicts or failing checks
// the hopper tends itself, and is no decision. Tagged (issue #1141) counts the GitHub items that wait on the person's own review
// or reply. Checks (issue #1244) counts the repositories whose pull request checks GitHub refuses to the hopper's connection,
// one line each, with the fix: no pull request there merges until a person gives the permissions. Accounts (issue #1128) counts the machines whose agent tool is signed in as nobody, each named: its jobs wait on a sign-in.
// Landing (issue #1333) counts the repositories whose landing pass failed the same way on several passes in a row, each with
// its error: nothing moves to the tested branch until a person restarts the batch or fixes the cause.
// Machines (issue #1248) counts the online machines that are not ready, each named with why: its job user holds credentials, or it is off-network.
// Unknown clusters (issue #2168) counts the templates with an unknown asset (issue #2067), each named: a job's need names a
// cluster the vault cannot find, or a short name of several. A row of its own, never in Access requests: that row, and its
// nav badge, count only what waits for a person's approval, and no approval makes such a template work.
// Access requests marks the run cards of high-priority jobs (issue #2197), as the nav badge marks a high-priority question.
// Infra plans names each plan that waits, and marks those a high-priority job recorded (issue #2205): a job that waits on a
// plan's approval links to it on Infra, where a person approves it.
// Schedules (issue #2716) counts the step schedules whose newest run failed, each with why: Needs you lists it until a run succeeds.
// A machine's join takes no approval (a join code joins it at once); a machine whose box template waits counts in Access requests.
import type { SectionKind } from './wire.ts';

export const NEEDS_YOU_KINDS = ['intake', 'access', 'unknown-assets', 'plans', 'questions', 'proposals', 'research', 'logins', 'accounts', 'machines', 'failures', 'budgets', 'pull-requests', 'checks', 'landing', 'tagged', 'schedules', 'sorting'] as const;
export type NeedsYouKind = (typeof NEEDS_YOU_KINDS)[number];

export interface NeedsYouCounts {
  /** Request cards that wait for approval, and labelled issues not assigned to the user (issue #1614), across the sources. */
  intake: number;
  /** Credential requests, vault grant asks, a person's own templates and the run cards that wait for approval. */
  access: number;
  /** Of those, the run cards a high-priority job waits on (issues #2196, #2197); absent: none. */
  accessHigh?: number;
  /** The templates with an unknown asset (issue #2067), one line each; absent: none. */
  unknownAssets?: readonly string[];
  /** Infra plans that wait for a person to approve them. */
  plans: number;
  /** Of those, the ones a high-priority job recorded (issue #2205); absent: none. */
  plansHigh?: number;
  /** One line per plan that waits (issue #2205); absent: none. */
  planLines?: readonly string[];
  /** The machines whose agent tool is signed in as nobody (issue #1128), one line each. */
  signedOut: readonly string[];
  /** The online machines that are not ready (issue #1248), one line each, with why. */
  notReady: readonly string[];
  /** The jobs their token budget paused (issue #2302), one line each, with why; absent: none. */
  budgetPaused?: readonly string[];
  /** The open pull requests the hopper gave up on (issue #927), one line each, with why. */
  gaveUp: readonly string[];
  /** The checks read problems (issue #1244), one line per repository, with the fix. */
  checksUnread: readonly string[];
  /** The stuck landing passes (issue #1333), one line per repository, with its error. */
  stuckLanding: readonly string[];
  /** Tagged items (issue #1141): open issues and pull requests that ask for the user's review, mention or are assigned to the user. */
  tagged: number;
  /** The step schedules whose newest run did not succeed (issue #2716), one line each; absent: none. */
  failedSchedules?: readonly string[];
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
  intake: { label: 'Intake', href: '#intake', what: 'issues from people outside your trusted actors, waiting for your approval, labelled issues not assigned to you: no job starts until you assign them, and jobs held by their trust stamp' },
  access: { label: 'Access requests', href: '#approvals/access-requests', what: 'credentials, vault grants, box templates and sandbox runs that jobs on boxes wait for you to approve' },
  'unknown-assets': { label: 'Unknown clusters', href: '#approvals/access-requests', what: 'templates that name a cluster the vault cannot find, or a short name of several clusters: point each at a cluster, add a cluster override, or remove it' },
  plans: { label: 'Infra plans', href: '#infra', what: 'plans of infrastructure changes that wait for a person to approve them' },
  questions: { label: 'Questions', href: '#questions', what: 'questions jobs asked you' },
  proposals: { label: 'Proposals', href: '#proposals', what: 'proposals that wait for you to pick a path' },
  research: { label: 'Research', href: '#research', what: 'research reports that wait for you to accept or steer them' },
  logins: { label: 'Logins', href: '#machines/logins', what: 'logins a job waits on, and connections that ended' },
  accounts: { label: 'Accounts', href: '#machines/accounts', what: 'machines whose agent tool is signed in as nobody: sign them in again' },
  machines: { label: 'Machines', href: '#machines', what: 'machines that are not ready and take no new job: give their jobs a dedicated user with no credentials, or a way to reach the hopper' },
  failures: { label: 'Failures', href: '#failures', what: 'open problems, jobs handed off to a person, and work not pushed' },
  budgets: { label: 'Budgets', href: '#parked', what: 'jobs paused because they reached their token budget: pick one up to let it go on, or cancel it' },
  'pull-requests': { label: 'Pull requests', href: '#pull-requests', what: 'pull requests the hopper gave up on: tend them again, fix them, or close them' },
  checks: { label: 'Checks', href: '#pull-requests', what: 'repositories whose pull request checks the hopper may not read: give its connection the permissions' },
  landing: { label: 'Landing', href: '#settings/landing-batches', what: 'landing passes that failed the same way several times in a row: nothing moves to the tested branch until you restart the batch or fix the cause' },
  tagged: { label: 'Tagged', href: '#tagged', what: 'issues and pull requests that ask for your review, mention you, or are assigned to you' },
  schedules: { label: 'Schedules', href: '#vault', what: 'step schedules whose last run failed, or that the hopper could not start: read its output, fix the cause, and run it again' },
  sorting: { label: 'Waiting to be ordered', href: '#jobs/queue', what: 'jobs waiting to be ordered before a lane takes them' },
};

export function needsYouRows(c: NeedsYouCounts): NeedsYouRow[] {
  const count = (k: NeedsYouKind): { n: number; high: number; details?: readonly string[] } => {
    if (k === 'intake') return { n: c.intake, high: 0 };
    if (k === 'access') return { n: c.access, high: c.accessHigh ?? 0 };
    if (k === 'unknown-assets') {
      const unknown = c.unknownAssets ?? [];
      return { n: unknown.length, high: 0, ...(unknown.length ? { details: unknown } : {}) };
    }
    if (k === 'plans') return { n: c.plans, high: c.plansHigh ?? 0, ...(c.planLines?.length ? { details: c.planLines } : {}) };
    if (k === 'budgets') { const paused = c.budgetPaused ?? []; return { n: paused.length, high: 0, ...(paused.length ? { details: paused } : {}) }; }
    if (k === 'pull-requests') return { n: c.gaveUp.length, high: 0, ...(c.gaveUp.length ? { details: c.gaveUp } : {}) };
    if (k === 'checks') return { n: c.checksUnread.length, high: 0, ...(c.checksUnread.length ? { details: c.checksUnread } : {}) };
    if (k === 'accounts') return { n: c.signedOut.length, high: 0, ...(c.signedOut.length ? { details: c.signedOut } : {}) };
    if (k === 'machines') return { n: c.notReady.length, high: 0, ...(c.notReady.length ? { details: c.notReady } : {}) };
    if (k === 'landing') return { n: c.stuckLanding.length, high: 0, ...(c.stuckLanding.length ? { details: c.stuckLanding } : {}) };
    if (k === 'tagged') return { n: c.tagged, high: 0 };
    if (k === 'schedules') { const failed = c.failedSchedules ?? []; return { n: failed.length, high: 0, ...(failed.length ? { details: failed } : {}) }; }
    if (k === 'sorting') return { n: c.sorting, high: 0 };
    return c.sections[k];
  };
  return NEEDS_YOU_KINDS.map((kind) => ({ kind, ...ROW[kind], ...count(kind) }));
}

/** The nav badge: every row's count, and the high-priority ones among them. */
export const needsYouTotal = (rows: readonly NeedsYouRow[]): { n: number; high: number } =>
  rows.reduce((t, r) => ({ n: t.n + r.n, high: t.high + r.high }), { n: 0, high: 0 });
