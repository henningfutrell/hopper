// Known causes (issue #509): the built-in ones, matched by the error text, and the ones a person named for a
// signature (`NamedCause`), which win. Shared causes first: a machine that cannot be reached is not a hiccup. Pure.
import { DONE_CRITERIA_UNMET_TEXT } from '../domain/conditional-skills.ts';
import { OWN_PR_CHECKS_RED_TEXT, OWN_PR_UNFINISHED_TEXT, workShipped, type CauseCheck, type FailureClass, type FailureDecision, type KnownCause, type MachineSnapshot, type NamedCause, type WorkState } from '../domain/types.ts';

interface BuiltinCause extends KnownCause { pattern: RegExp }

const cause = (c: Omit<BuiltinCause, 'builtin'>): BuiltinCause => ({ ...c, builtin: true });

/** The cause of a job whose own pull request's checks are red (issue #1230): the hopper finishes it (`checks-red.ts`). */
export const OWN_PR_CHECKS_RED = 'own-pr-checks-red';
/** The cause of a job whose own pull request has merge conflicts or is a draft (issue #1265): the hopper sends it back to finish it. */
export const OWN_PR_UNFINISHED = 'own-pr-unfinished';
/** The cause of a job whose session has no way to the hopper (issue #2233): it runs again as a new job, never in that session. */
export const NO_WAY_TO_HOPPER = 'no-way-to-hopper';
/** The cause of a job whose agent CLI exited as it started (issue #2432): the seat's fault, so it runs again on another lane. */
export const EXITED_AT_START = 'exited-at-start';
/** The cause of a job whose agent CLI exited after the OOM killer stopped processes in its scope (issue #2498): resources, not its code. */
export const RESOURCE_LIMIT = 'resource-limit';
/** The cause of a job whose agent CLI exited after the hopper's sweep stopped its processes (issue #2707): the hopper's act, not the agent's. */
export const SWEPT = 'swept';
/** The cause of a job whose conditional skills' done criteria are not met (issue #1924): the hopper sends it back to rework. */
export const DONE_CRITERIA_UNMET = 'done-criteria-unmet';

export const BUILTIN_CAUSES: readonly BuiltinCause[] = [
  // Before the agent's own exits (issue #2707): its text says how the agent exited too.
  cause({
    id: SWEPT, name: 'Stopped by the sweep', cls: 'transient', decision: 'retry', scope: 'machine',
    description: 'The hopper\'s sweep stopped the job\'s processes while the hopper read the job as not running (queued, held or parked), and its agent CLI then exited, often with exit code 143 (signal 15): the hopper\'s own act, not the agent\'s or the job\'s (issue #2707). The failure says the machine and the status the sweep read. It runs again.',
    pattern: /^the hopper's sweep stopped its processes/i,
  }),
  // Then (issue #2235): the read error it names is the hopper's own read of the source, never the machine's or the agent's.
  cause({
    id: 'done-check-unread', name: 'Done check unread', cls: 'transient', decision: 'retry', scope: 'machine',
    description: 'The job said it was done, but the hopper could not read its source to check the work, also after it tried again with backoff (a connect timeout, a busy service, a rate limit). Nothing showed the work incomplete. Before it runs again, its source is asked whether the work is done there: then it ends finished.',
    pattern: /could not confirm the work is complete/i,
  }),
  // Before every cause what Claude printed may name (issue #2498): the hopper's own reading of the job's scope says it.
  cause({
    id: RESOURCE_LIMIT, name: 'Resource limit', cls: 'transient', decision: 'retry', scope: 'machine',
    description: 'The agent CLI exited after the kernel\'s OOM killer stopped processes in the job\'s scope: the job ran out of memory, at its memory limit or the machine\'s, not into a fault of its code. The failure says how many processes it stopped. It runs again with backoff, and the memory floor decides where it starts. The job\'s parts list shows its peak memory and OOM kills.',
    pattern: /at a resource limit: the kernel's OOM killer stopped \d+ process(es)? in the job's scope/,
  }),
  cause({
    id: 'socket-path-too-long', name: 'Socket path too long', cls: 'shared', decision: 'redirect', scope: 'machine',
    description: 'A Unix socket path under the job\'s TMPDIR is longer than the system allows: every job with the same TMPDIR on that machine crashes the same way.',
    pattern: /socket path (is )?too long|path too long for (a )?unix (domain )?socket|ENAMETOOLONG/i,
  }),
  // Before Login expired, whose words a job's text may quote (issue #2233); and a checkpoint restore's (issue #2316). Not the reach check's own text ("cannot reach
  // the hopper at <url>"): that is the machine's, and stays Machine offline when the machine refused it.
  cause({
    id: NO_WAY_TO_HOPPER, name: 'No way to the hopper', cls: 'transient', decision: 'retry', scope: 'machine',
    description: 'The job\'s session has no way to the hopper: HOPPER_URL, HOPPER_GH, its token file or its credentials dir is missing (also when its checkpoint is restored on another machine), so it cannot push, ask the hopper or run steps. That session cannot go on: the job runs again as a new job, its way to the hopper placed afresh, and Continue on its hand-off runs a new job too.',
    pattern: /cannot reach the hopper(?! at )|hopper: the job has no way to the hopper|\bHOPPER_(?:URL|GH)\b[^\n]{0,80}?\b(?:missing|not set|unset|empty)\b/i,
  }),
  cause({
    id: 'login-expired', name: 'Login expired', cls: 'shared', decision: 'hold', scope: 'executor',
    description: 'The agent CLI or a tool it uses is signed out on that machine, or its token expired: every job of that executor there fails until someone signs in again.',
    pattern: /not logged in|log(ged)? ?in (has )?expired|please (run )?\/?login|auth(entication)? (failed|required)|gh auth login|bad credentials|invalid (api key|credentials|token)|(token|session) (has )?expired|401 unauthorized/i,
  }),
  cause({
    id: 'disk-full', name: 'Disk full', cls: 'shared', decision: 'redirect', scope: 'machine', check: 'disk',
    description: 'The machine\'s disk is full: no job can write its work there until space is freed.',
    pattern: /ENOSPC|no space left on device|disk (is )?full|disk quota exceeded/i,
  }),
  cause({
    id: 'machine-offline', name: 'Machine offline', cls: 'shared', decision: 'redirect', scope: 'machine', check: 'online',
    description: 'The hopper cannot reach the machine: its jobs cannot start or report there until it is back.',
    pattern: /did not reconnect|is not attached|is not dialled in|machine \S+ (is )?(offline|unreachable)|EHOSTUNREACH|ECONNREFUSED|no route to host|ssh: connect to host|could not resolve hostname|host is down/i,
  }),
  cause({
    id: 'herdr-outdated', name: 'Herdr outdated', cls: 'shared', decision: 'redirect', scope: 'machine', check: 'herdr',
    description: 'The herdr client the hopper calls on the machine is older than the herdr server of its session: every job start there fails until the server\'s herdr is installed where the hopper calls it (issue #741).',
    pattern: /client protocol \d+ is older than server protocol \d+/i,
  }),
  // After Login expired: what Claude printed as it exited may say it is signed out, which holds the executor (issue #2432).
  cause({
    id: EXITED_AT_START, name: 'Exited at start', cls: 'transient', decision: 'retry', scope: 'machine',
    description: 'The agent CLI exited as it started, or in its first turn of a new session before it showed anything, with no cause its output names: the seat it ran on, not the job (issue #2432). The failure says its exit code and what it printed. It runs again with backoff, on another lane, of another machine when one may take it; a lane where it happens 3 times in a row takes no new job for a while.',
    pattern: /claude exited at (startup|the start of a new session)/i,
  }),
  cause({
    id: 'daemon-restart', name: 'Daemon restart', cls: 'transient', decision: 'retry', scope: 'machine',
    description: 'The hopper restarted while the job ran: its work was cut off, not wrong.',
    pattern: /interrupted by daemon restart/i,
  }),
  cause({
    id: 'link-closed', name: 'Link closed', cls: 'transient', decision: 'retry', scope: 'machine',
    description: 'The machine\'s link to the hopper closed before it answered: it dropped for a moment, or the machine went away (then the next run finds it offline).',
    pattern: /its link closed/i,
  }),
  cause({
    id: 'network', name: 'Network blip', cls: 'transient', decision: 'retry', scope: 'machine',
    description: 'A connection dropped or a service answered busy for a moment.',
    pattern: /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network (error|is unreachable)|temporar(il)?y (unavailable|failure)|overloaded|rate limit|\b50[234]\b/i,
  }),
  cause({
    id: 'timed-out', name: 'Timed out', cls: 'transient', decision: 'continue', scope: 'machine',
    description: 'The job ran out of its time. Its liveness decides (`timed-out.ts`): still at work — recent pane output, commits pushed, or a pull request of its own open — it goes on; silent, it runs again once, then goes to a person.',
    pattern: /^timed out$/,
  }),
  cause({
    id: 'start-race', name: 'Start race', cls: 'transient', decision: 'retry', scope: 'machine',
    description: 'The agent did not start, or its pane went away, before the job was under way.',
    pattern: /did not start|failed to start|pane (was )?(lost|closed|not found|gone)|lost (the )?send/i,
  }),
  cause({
    id: 'question-unanswered', name: 'Question unanswered', cls: 'job', decision: 'person', scope: 'machine',
    description: 'The job asked a question nobody answered in time, or asked too many.',
    pattern: /question unanswered|too many questions|question (dismissed|missing)/i,
  }),
  cause({
    id: 'invalid-spec', name: 'Invalid job', cls: 'job', decision: 'person', scope: 'machine',
    description: 'The job\'s item cannot run as written: its payload, its executor or its text is wrong.',
    pattern: /invalid payload|unknown executor|invalid spec|must be a string|must be one of/i,
  }),
  // Before Not complete, whose text it shares (issue #1230): the job's own pull request is there, only its checks are red.
  cause({
    id: OWN_PR_CHECKS_RED, name: 'Own PR checks red', cls: 'transient', decision: 'continue', scope: 'machine',
    description: 'The job said it was done, but the checks of its own pull request failed. The hopper finishes it, not a person: it runs the failed checks again once (a flaky check), then sends the job back in its own session with the failed checks and their logs, to fix them on the same branch. Each send-back counts against the retry limit; only then a person. Its own job\'s: it never groups or holds other jobs.',
    pattern: OWN_PR_CHECKS_RED_TEXT,
  }),
  // Before Not complete, whose text it shares (issue #1265): the job's own pull request is there, with merge conflicts or a draft.
  cause({
    id: OWN_PR_UNFINISHED, name: 'Own PR unfinished', cls: 'transient', decision: 'continue', scope: 'machine',
    description: 'The job said it was done, but its own pull request has merge conflicts with its base, or is a draft. The hopper finishes it, not a person: it sends the job back in its own session (else a new job of its item), told to rebase onto the base branch, resolve the conflicts, make the checks pass and push, or to mark the pull request ready. Each send-back counts against the retry limit; only then a person. Its own job\'s: it never groups or holds other jobs.',
    pattern: OWN_PR_UNFINISHED_TEXT,
  }),
  // Before Not complete, whose text it shares (issue #1924): its pull request is there, but a done criterion of its skills is not met.
  cause({
    id: DONE_CRITERIA_UNMET, name: 'Done criteria unmet', cls: 'transient', decision: 'continue', scope: 'machine',
    description: 'The job said it was done, and its own pull request is ready for review, but a done criterion of a conditional skill it got is not met: a check it names did not pass, or a terraform plan destroys or replaces a resource. The hopper checks this itself and does not trust the job. It sends the job back in its own session (else a new job of its item), told what it found, to rework it on the same branch. Each send-back counts against the retry limit; then it ends failed with the reason, for a person. Its own job\'s: it never groups or holds other jobs.',
    pattern: DONE_CRITERIA_UNMET_TEXT,
  }),
  cause({
    id: 'not-complete', name: 'Not complete', cls: 'job', decision: 'person', scope: 'machine',
    description: 'The job said it was done, but its source, asked twice a minute apart, found its item open and no pull request that closes or references it ready for review (not a draft, no merge conflicts) or merged. A pull request waiting for its merge is never this: it is done. Looked at once more before it is assessed; then Jev may pick run it again. Its own job\'s: it never groups or holds other jobs.',
    pattern: /^not complete:/i,
  }),
];

const CLASS_OF: Record<FailureDecision, FailureClass> = { retry: 'transient', hold: 'shared', redirect: 'shared', person: 'job', continue: 'transient' };

/** A named cause as a known cause: its class follows its decision. */
export function namedCause(n: NamedCause): KnownCause {
  return { id: `named:${n.signature}`, name: n.name, description: n.description, cls: CLASS_OF[n.decision], decision: n.decision, scope: 'machine', builtin: false };
}

/** The known cause of a failure: the one a person named for its signature, else the first built-in one whose text matches. */
export function matchCause(text: string, signature: string, named: readonly NamedCause[]): KnownCause | undefined {
  const mine = named.find((n) => n.signature === signature);
  if (mine) return namedCause(mine);
  const hit = BUILTIN_CAUSES.find((c) => c.pattern.test(text));
  if (!hit) return undefined;
  const { pattern: _p, ...known } = hit;
  return known;
}

/** A built-in cause by its id, as `matchCause` answers it; undefined: none. */
export function builtinCause(id: string): KnownCause | undefined {
  const hit = BUILTIN_CAUSES.find((c) => c.id === id);
  if (!hit) return undefined;
  const { pattern: _p, ...known } = hit;
  return known;
}

/**
 * The cause the job's work shows, read before its failure text (issue #1522): its item open, nothing shipped, and a pull
 * request it opened or pushed to open with merge conflicts or as a draft — Own PR unfinished —, else ready but for its red
 * checks — Own PR checks red. Undefined: neither. The hopper finishes its own pull request; a wording drift of the
 * done check's miss must not hand it to a person.
 */
export function ownPullRequestCause(work: Pick<WorkState, 'item' | 'pullRequests'>): typeof OWN_PR_UNFINISHED | typeof OWN_PR_CHECKS_RED | undefined {
  if (work.item !== 'open' || workShipped(work)) return undefined;
  const open = work.pullRequests.filter((pr) => pr.state === 'open');
  if (open.some((pr) => pr.conflicting || pr.draft)) return OWN_PR_UNFINISHED;
  return open.some((pr) => pr.checks === 'failing') ? OWN_PR_CHECKS_RED : undefined;
}

/** Every known cause, the named ones first, as the Failures view lists them. */
export function knownCauses(named: readonly NamedCause[]): KnownCause[] {
  return [...named.map(namedCause), ...BUILTIN_CAUSES.map(({ pattern: _p, ...c }) => c)];
}

/** Whether a check sees its cause on the problem's machine: offline, its disk low, its herdr problem (issue #741). */
export function causePresent(check: CauseCheck, m: MachineSnapshot): boolean {
  if (check === 'online') return !m.online;
  if (check === 'disk') return m.disk?.low === true;
  return m.herdrProblem !== undefined;
}
