// Whose ask a box's vault ask is (issue #558 slice 3, issue #580): the machine whose link signed it, the job whose proxy
// token it shows, and the template that machine joined as. A delivery and a mint check the same things in the same
// order, here, before either looks at what is asked; the first that fails is the reason the job is told.
import { machineOfLane } from '../domain/raised-by.ts';
import type { Job } from '../domain/types.ts';
import { parseProxyToken, type ProxyTokenParts } from '../github-proxy/token.ts';

/** The statuses a job is given vault secrets or minted credentials in: it holds its pane. Ended, failed or parked: nothing. */
export const AT_WORK: readonly string[] = ['running', 'waiting_answer', 'waiting_on'];

/**
 * What a box the hopper launched was launched with (issue #708): the secrets of its template's scope it is given, and
 * the one operation profile it is minted for, when its launch named one. Its sandbox record keeps both.
 */
export interface LaunchScope { secrets: string[]; profile?: { operation: string; asset: { kind: string; name: string } } }

/**
 * An attached machine as the vault knows it (issue #558): a client target's name, its machine key, its template, and,
 * for a box the hopper launched from a template, what its launch named (absent: all its template gives).
 */
export interface ClientTarget { name: string; key: string; template?: string; launch?: LaunchScope }

/** The client targets, each box among them with what its launch gave it (issue #708). */
export const withLaunch = (targets: ClientTarget[], scopes: Map<string, LaunchScope> | undefined): ClientTarget[] =>
  targets.map((m) => { const launch = scopes?.get(m.name); return launch ? { ...m, launch } : m; });

/** Why a box's launch does not give it the secret `name`; undefined: it does, or the box was not launched with a scope. */
export function launchRefusal(m: { name: string; launch?: LaunchScope }, name: string): string | undefined {
  const secrets = m.launch?.secrets;
  return !secrets || secrets.includes(name) ? undefined : `${m.name} was launched with ${secrets.join(', ') || 'no secret'} only: ${name} is not given to it`;
}

/** The secrets of `scope` a box's launch gives it. */
export const launchedOf = (m: { launch?: LaunchScope } | undefined, scope: string[]): string[] => (m?.launch ? scope.filter((s) => m.launch!.secrets.includes(s)) : scope);

export interface BoxAskOptions {
  /** The client targets now: each one's key and the template it joined as. */
  targets?: () => ClientTarget[];
  /** Whether a job's proxy token is one this user's link key gives it (issue #563). */
  holds?: (parts: ProxyTokenParts) => boolean;
  job(id: string): Job | undefined;
  /** Whether the vault holds this template (issue #604): a box of one that is not there is refused. Absent: not checked. */
  holdsTemplate?: (name: string) => boolean;
}

/** What is known of an ask, as far as the checks got: the machine, the job. With `refused`, why not; else all of it. */
export type BoxAsk =
  | { refused: string; machine?: { name: string; template?: string }; job?: Job }
  | { machine: { name: string; template: string; launch?: LaunchScope }; job: Job };

/** A client target, found by `match`; undefined when none matches. */
export const clientOf = (targets: (() => ClientTarget[]) | undefined, match: (m: ClientTarget) => boolean): ClientTarget | undefined => (targets?.() ?? []).find(match);

/** The machine holding `machineKey`, the job `token` names, and the template, or the first check that fails. */
export function boxAsk(o: BoxAskOptions, token: string, machineKey: string): BoxAsk {
  const m = clientOf(o.targets, (x) => x.key === machineKey);
  const parts = parseProxyToken(token);
  const job = parts && parts.userId !== undefined ? o.job(parts.jobId) : undefined;
  const known = { ...(m ? { machine: m } : {}), ...(job ? { job } : {}) };
  if (!m) return { ...known, refused: 'no joined machine holds that key' };
  if (!parts || !o.holds?.(parts)) return { ...known, refused: 'not a token the hopper gave a job of this user' };
  if (!job || !AT_WORK.includes(job.status)) return { ...known, refused: `the job is not at work (${job?.status ?? 'no such job'}): the vault gives only while it runs` };
  if ((machineOfLane(job.laneId) ?? job.resumeOn) !== m.name) return { ...known, refused: `the job does not run on ${m.name}` };
  if (m.template === undefined) return { ...known, refused: `${m.name} is no box of a template: only a box joined with a template's line gets vault secrets or minted credentials` };
  if (o.holdsTemplate && !o.holdsTemplate(m.template)) return { ...known, refused: `${m.name} is a box of ${m.template}, a template that is not there: a person removes the box` };
  return { machine: { name: m.name, template: m.template, ...(m.launch ? { launch: m.launch } : {}) }, job };
}
