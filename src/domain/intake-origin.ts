// Trusted origin and request cards (issue #652, design.md "Trusted origin and request cards"): an issue becomes a job
// only when its author, whoever added the label the hopper takes it by and whoever assigned it to the user are the
// user's trusted actors — the logins named in Settings → Intake, else the user's connected login — and no job filed it.
// Apps and bots never are trusted actors. Any other open labelled issue assigned to the user is a request card: a person
// reads its title and body and approves them, and the job runs that approved text. Pure.
import { createHash } from 'node:crypto';

/** What an actor did to the issue: wrote it, added the label, or assigned it to the user. */
export type OriginRole = 'author' | 'labelled' | 'assigned';

/** One act of an issue's origin, and whether the user's trusted actors hold it. */
export interface OriginActor {
  role: OriginRole;
  /** Who did it; absent when the issue's events do not say (the label or the assignment not found). */
  login?: string;
  /** The app or bot that did it: never a trusted actor. */
  app?: string;
  trusted: boolean;
}

/** Where a job's item came from (issue #652): a trusted origin, or a request card a person approved. */
export const JOB_ORIGINS = ['trusted', 'approved'] as const;
export type JobOrigin = typeof JOB_ORIGINS[number];

/** A request card: an issue not of a trusted origin, waiting for a person to approve its text. */
export interface IntakeRequest {
  /** The SHA-256 of its title and body (`requestHash`): what Approve names, so only the text shown is approved. */
  hash: string;
  title: string;
  body: string;
  author: string;
  actors: OriginActor[];
  /** Why it is a request, one reason each. */
  why: string[];
  /** The text a person approved before, when the issue's title or body changed since. */
  approved?: { title: string; body: string };
}

/** The intake's trusted actors, as Settings → Intake keeps them; absent: the user's connected login only. */
export interface IntakeActorSettings { actors: string[] }

/** The hopper's note under an issue a job filed through it (src/github-proxy/policy.ts `filedNote`). */
export const FILED_BY_JOB = /\n---\nFiled through hopper for job `[^`]+`/;

export const FILED_BY_JOB_REASON = 'a job filed it';

/** The SHA-256 of an issue's title and body, hex. */
export function requestHash(t: { title: string; body: string }): string {
  return createHash('sha256').update(JSON.stringify([t.title, t.body])).digest('hex');
}

/** A GitHub login that is a bot or an app's (`name[bot]`). */
export const isBotLogin = (login: string): boolean => /\[bot\]$/i.test(login);

/** The trusted actors in force: the ones named, else the connected login. Lowercased, sorted, once each. */
export function trustedActors(s: IntakeActorSettings | undefined, connected: string): string[] {
  const named = s?.actors.length ? s.actors : [connected];
  return [...new Set(named.map((a) => a.trim().toLowerCase()).filter((a) => a !== ''))].sort();
}

const ROLE_TEXT: Record<OriginRole, string> = { author: 'written', labelled: 'labelled', assigned: 'assigned' };

/** Why an act does not count: by an app or a bot, by nobody the events name, or by a login that is no trusted actor. */
export function untrustedReason(a: OriginActor): string | undefined {
  if (a.trusted) return undefined;
  if (a.app) return `${ROLE_TEXT[a.role]} by an app or a bot (${a.app})`;
  if (!a.login) return `who ${a.role === 'author' ? 'wrote' : a.role === 'labelled' ? 'labelled' : 'assigned'} it is not known`;
  return `${ROLE_TEXT[a.role]} by ${a.login}, not a trusted actor`;
}
