// Whose ask a box's vault ask is (issue #558 slice 3, issue #580): the machine whose link signed it, the job whose proxy
// token it shows, and the template that machine joined as. A delivery and a mint check the same things in the same
// order, here, before either looks at what is asked; the first that fails is the reason the job is told.
import type { AttachedMachine } from '../domain/machines.ts';
import { machineOfLane } from '../domain/raised-by.ts';
import type { Job } from '../domain/types.ts';
import { parseProxyToken, type ProxyTokenParts } from '../github-proxy/token.ts';

/** The statuses a job is given vault secrets or minted credentials in: it holds its pane. Ended, failed or parked: nothing. */
export const AT_WORK: readonly string[] = ['running', 'waiting_answer'];

export interface BoxAskOptions {
  /** The attached machines now: a client target's key and the template it joined as. */
  targets?: () => AttachedMachine[];
  /** Whether a job's proxy token is one this user's link key gives it (issue #563). */
  holds?: (parts: ProxyTokenParts) => boolean;
  job(id: string): Job | undefined;
}

/** What is known of an ask, as far as the checks got: the machine, the job. With `refused`, why not; else all of it. */
export type BoxAsk =
  | { refused: string; machine?: { name: string; template?: string }; job?: Job }
  | { machine: { name: string; template: string }; job: Job };

/** A client target and the template it joined as, found by `match`; undefined when none matches. */
export function clientOf(targets: (() => AttachedMachine[]) | undefined, match: (m: { name: string; key: string }) => boolean): { name: string; template?: string } | undefined {
  return (targets?.() ?? []).flatMap((m) => ('client' in m && match({ name: m.name, key: m.client.key }) ? [{ name: m.name, ...(m.client.template !== undefined ? { template: m.client.template } : {}) }] : []))[0];
}

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
  return { machine: { name: m.name, template: m.template }, job };
}
