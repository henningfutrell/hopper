// Known causes (issue #509): the built-in ones, matched by the error text, and the ones a person named for a
// signature (`NamedCause`), which win. Shared causes first: a machine that cannot be reached is not a hiccup. Pure.
import type { FailureClass, FailureDecision, KnownCause, NamedCause } from '../domain/types.ts';

interface BuiltinCause extends KnownCause { pattern: RegExp }

const cause = (c: Omit<BuiltinCause, 'builtin'>): BuiltinCause => ({ ...c, builtin: true });

export const BUILTIN_CAUSES: readonly BuiltinCause[] = [
  cause({
    id: 'socket-path-too-long', name: 'Socket path too long', cls: 'shared', decision: 'redirect', scope: 'machine',
    description: 'A Unix socket path under the job\'s TMPDIR is longer than the system allows: every job with the same TMPDIR on that machine crashes the same way.',
    pattern: /socket path (is )?too long|path too long for (a )?unix (domain )?socket|ENAMETOOLONG/i,
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
  cause({
    id: 'not-complete', name: 'Not complete', cls: 'job', decision: 'person', scope: 'machine',
    description: 'The job said it was done, but its source, asked twice a minute apart, found its item open and no pull request that closes or references it ready for review (not a draft, no merge conflicts) or merged. A pull request waiting for its merge is never this: it is done. Looked at once more before it is assessed; then Jev may pick run it again. Its own job\'s: it never groups or holds other jobs.',
    pattern: /^not complete:|could not confirm the work is complete/i,
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

/** Every known cause, the named ones first, as the Failures view lists them. */
export function knownCauses(named: readonly NamedCause[]): KnownCause[] {
  return [...named.map(namedCause), ...BUILTIN_CAUSES.map(({ pattern: _p, ...c }) => c)];
}
