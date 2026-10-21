// Box actions (issue #795, design.md "API tokens" Box actions): the routes an API token may use only when it is a box
// token — the API token of a grant minted with `box: true` from a person's UI session (issue #881), never by the
// sign-in exchange — and Access allows
// `api_token#can_run_on_box`. A box action starts a job, runs a command, approves or merges work, updates the hopper or a
// client, or changes the work on a machine. Reads, holds and cancels are not: any API token of the role does them. A UI
// session is never asked: the person is there. The list is the boundary; a route that is not on it is no box action.
import { REVIEW_KINDS, REVIEW_SECTIONS } from '../../domain/types.ts';

export type BoxActionKind = 'start a job' | 'run a command' | 'approve or merge work' | 'update the hopper or a client' | 'change work on a machine';

/** One box action: the POST route as the hopper registers it, and the kind of box action it is. */
export interface BoxAction { route: string; kind: BoxActionKind }

/** A review decision that sends the item on runs a job again (accept: its follow-on; send back: a new version). */
const reviewDecisions: BoxAction[] = REVIEW_KINDS.flatMap((k) => REVIEW_SECTIONS[k].decisions
  .filter((d) => d.effect !== 'reject')
  .map((d) => ({ route: `/ui/api/${REVIEW_SECTIONS[k].section}/:id/${d.route}`, kind: 'start a job' as const })));
const askFor: BoxAction[] = REVIEW_KINDS.map((k) => ({ route: `/ui/api/jobs/:id/${REVIEW_SECTIONS[k].askPath}`, kind: 'start a job' as const }));
const phaseShifts: BoxAction[] = ['research', 'propose'].map((p) => ({ route: `/ui/api/questions/:id/${p}`, kind: 'start a job' as const }));

export const BOX_ACTIONS: readonly BoxAction[] = [
  { route: '/ui/api/jobs/:id/approve', kind: 'start a job' },
  { route: '/ui/api/jobs/:id/rerun', kind: 'start a job' },
  { route: '/ui/api/jobs/:id/rework', kind: 'start a job' },
  { route: '/ui/api/jobs/:id/requeue', kind: 'start a job' },
  { route: '/ui/api/jobs/:id/gate-pass', kind: 'start a job' },
  { route: '/ui/api/jobs/:id/unquarantine', kind: 'start a job' }, // issue #655: the job may start, and reach the hopper again
  { route: '/ui/api/jobs/:id/approve-trust', kind: 'start a job' }, // issue #655 part 4: the job Jev's check lowered may start
  { route: '/ui/api/sources/:name/intake', kind: 'start a job' },
  { route: '/ui/api/direct-jobs', kind: 'start a job' }, // issue #901
  { route: '/ui/api/sources/:name/tagged-start', kind: 'start a job' }, // issue #2342
  { route: '/ui/api/direct-queries', kind: 'start a job' }, // issue #2184
  { route: '/ui/api/repo-checks/queue', kind: 'start a job' },
  { route: '/ui/api/failures/:id/retry', kind: 'start a job' },
  { route: '/ui/api/failures/problems/:id/release', kind: 'start a job' },
  { route: '/ui/api/failures/kept-work/:id/push', kind: 'start a job' }, // issue #1010: the job goes on
  { route: '/ui/api/pull-requests/tend', kind: 'start a job' }, // issue #1010: Tend again
  { route: '/ui/api/failures/stuck/:cause', kind: 'start a job' }, // issue #1010: a stuck cause's bulk action
  ...askFor, ...phaseShifts, ...reviewDecisions,
  { route: '/ui/api/blast-radius/discover', kind: 'run a command' },
  { route: '/ui/api/plugins', kind: 'run a command' },
  { route: '/ui/api/pull-requests/merge', kind: 'approve or merge work' },
  { route: '/ui/api/infra-plans', kind: 'approve or merge work' },
  { route: '/ui/api/infra-plans/settings', kind: 'approve or merge work' },
  // Issue #991: the toggles approve templates and sandbox runs with no person.
  { route: '/ui/api/sandbox-approvals', kind: 'approve or merge work' },
  { route: '/ui/api/sandbox-strictness', kind: 'approve or merge work' },
  { route: '/ui/api/update', kind: 'update the hopper or a client' },
  { route: '/ui/api/plugin-store', kind: 'update the hopper or a client' },
  { route: '/ui/api/questions/:id/answer', kind: 'change work on a machine' },
  { route: '/ui/api/questions/:id/correct', kind: 'change work on a machine' },
  { route: '/ui/api/jobs/:id/end-wait', kind: 'change work on a machine' },
  { route: '/ui/api/jobs/:id/notes', kind: 'change work on a machine' }, // issue #997: typed into the job's session
  { route: '/ui/api/jobs/:id/keep-original', kind: 'change work on a machine' },
  { route: '/ui/api/jobs/:id/accept-new-text', kind: 'change work on a machine' },
  { route: '/ui/api/logins/:id/new-code', kind: 'change work on a machine' },
  // Issue #1128: a machine's agent tool signed in again, and the code its sign-in page showed.
  { route: '/ui/api/tool-accounts/sign-in', kind: 'change work on a machine' },
  { route: '/ui/api/logins/:id/code', kind: 'change work on a machine' },
  { route: '/ui/api/logins/claude-setup-token', kind: 'run a command' }, // issue #1287: claude setup-token in the hopper
  { route: '/ui/api/jobs/:id/terminal/input', kind: 'change work on a machine' }, // issue #1128: typed into a job's pane
  { route: '/ui/api/machines/:id/terminal/input', kind: 'change work on a machine' }, // issue #1128: typed into a pane on a machine
  { route: '/ui/api/machines', kind: 'change work on a machine' },
  { route: '/ui/api/machines/join', kind: 'change work on a machine' },
  { route: '/ui/api/machines/pool-key', kind: 'change work on a machine' }, // issue #1454: lane pods join with it
  { route: '/ui/api/sandbox-playground', kind: 'change work on a machine' }, // issue #1410: starts sandboxes
  { route: '/ui/api/sandbox-requests', kind: 'change work on a machine' }, // issue #991: approving one lets the job's box steps run
  // Issue #731: where a job's Windows sandbox steps run, with the hopper's own ssh key.
  { route: '/ui/api/windows-hosts', kind: 'change work on a machine' },
  // Issue #1467: the credential check — a machine used anyway or acknowledged, a machine stopped, strict mode.
  { route: '/ui/api/machines/:id/credentials/accept', kind: 'change work on a machine' },
  { route: '/ui/api/machines/:id/credentials/revoke', kind: 'change work on a machine' },
  { route: '/ui/api/credential-check', kind: 'change work on a machine' },
  { route: '/ui/api/lanes/apply', kind: 'change work on a machine' },
  { route: '/ui/api/lanes/undo', kind: 'change work on a machine' },
  { route: '/ui/api/failures/kept-work/:id/discard', kind: 'change work on a machine' }, // issue #1010: removes work not pushed
  { route: '/ui/api/machines/leftovers', kind: 'change work on a machine' }, // issue #1116: removes a leftover on a machine
];

const ROUTES = new Set(BOX_ACTIONS.map((b) => b.route));

/** Whether the route (as registered, e.g. `/ui/api/jobs/:id/approve`) is a box action. */
export const isBoxAction = (route: string | undefined): boolean => route !== undefined && ROUTES.has(route);

/** Why an API token that is no box token is refused a box action. */
export const NOT_A_BOX_TOKEN = 'this is a box action: it needs a box token, the API token of a grant a person mints with box: true from a UI session (Users & access → API tokens, or POST /ui/api/api-tokens)';
