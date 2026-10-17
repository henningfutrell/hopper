// Trusted origin and request cards (issue #652, design.md "Trusted origin and request cards"): an issue becomes a job
// only when its author, whoever added the label the hopper takes it by and whoever assigned it to the user are the
// user's trusted actors — the GitHub accounts named in Settings → Intake, by user id (issue #930), else the user's
// connected login — and no job filed it.
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
  /** Their GitHub user id (issue #930); absent when GitHub did not say. */
  id?: number;
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
  /** A reopened card (issue #1126): the issue was reopened after its job was done; the item's history. */
  reopened?: ItemHistory;
}

/** What a reopened item did before (issue #1126): its jobs, newest first, and its pull request. */
export interface ItemHistory {
  jobs: { id: string; status: string }[];
  pullRequest?: string;
}

/** A GitHub account as GitHub answers it (issue #930): its user id, which a rename keeps, its login now, its type and avatar. */
export interface GitHubAccount {
  id: number;
  login: string;
  /** GitHub's type: `User`, `Bot`, `Organization`, `Mannequin`. Only a `User` is a trusted actor. */
  type: string;
  avatarUrl?: string;
}

/**
 * The intake's trusted actors, as Settings → Intake keeps them; absent: the user's connected login only. `accounts`: by
 * GitHub user id (issue #930). `actors`: their logins, lowercased, which the build before #930 reads; a list kept then has
 * only these, and counts by login until it is saved again.
 */
export interface IntakeActorSettings { actors: string[]; accounts?: GitHubAccount[] }

/** Where the trusted actor picker found an account (issue #930), in the order it shows them. */
export const CANDIDATE_FROM = ['connected', 'collaborator', 'member', 'author', 'hopper-user', 'api-token'] as const;
export type CandidateFrom = typeof CANDIDATE_FROM[number];

/** An account the picker offers, and where it found it. */
export interface ActorCandidate extends GitHubAccount { from: CandidateFrom[] }

/** GET /api/intake-actors/candidates: the accounts offered, by login; and what could not be read, one line each. */
export interface ActorCandidates { candidates: ActorCandidate[]; problems: string[] }

/** GET /api/intake-actors: the accounts named by id, the logins named before ids (to pick again), and the connected login. */
export interface IntakeActorsView {
  accounts: GitHubAccount[];
  /** Logins kept before issue #930, with no id: they count by login until the list is saved again. */
  unresolved: string[];
  /** The connected login, the one trusted actor while none is named; null: no GitHub connected. */
  connected: string | null;
}

/** One who did an act on GitHub, or a trusted actor: a login, and its GitHub user id when known. */
export interface ActorRef { login: string; id?: number }

/**
 * The hopper's note under an issue a job filed through it (src/github-proxy/policy.ts `filedNote`): after its rule, the
 * lineage line of a child (issue #729), when it has one, then the mark (issue #1510: a child's mark was missed).
 */
export const FILED_BY_JOB = /\n---\n(?:[^\n]*\n)?Filed through hopper for job `[^`]+`/;

export const FILED_BY_JOB_REASON = 'a job filed it';

/** The SHA-256 of an issue's title and body, hex. */
export function requestHash(t: { title: string; body: string }): string {
  return createHash('sha256').update(JSON.stringify([t.title, t.body])).digest('hex');
}

/** A GitHub login that is a bot or an app's (`name[bot]`). */
export const isBotLogin = (login: string): boolean => /\[bot\]$/i.test(login);

const ref = (login: string, id: number | undefined): ActorRef => ({ login: login.trim().toLowerCase(), ...(id !== undefined ? { id } : {}) });

/**
 * The trusted actors in force: the accounts named, by id (issue #930); else the logins named before ids; else the
 * connected login. Logins lowercased, sorted by login, once each.
 */
export function trustedActors(s: IntakeActorSettings | undefined, connected: ActorRef): ActorRef[] {
  const named = s?.accounts?.length ? s.accounts.map((a) => ref(a.login, a.id))
    : s?.actors.length ? s.actors.map((a) => ref(a, undefined))
      : [ref(connected.login, connected.id)];
  const once = new Map(named.filter((a) => a.login !== '').map((a) => [a.id !== undefined ? `#${a.id}` : a.login, a]));
  return [...once.values()].sort((a, b) => a.login.localeCompare(b.login));
}

/**
 * The logins Access is told as the trusted actors when it decides `act` (issue #930): a trusted actor of the act's id is
 * told by the act's login, as its account is named now; a trusted actor whose login the act has but whose id is another
 * is not told, as that login now names another account. An id not known on either side compares by login.
 */
export function toldFor(actors: readonly ActorRef[], act: ActorRef): string[] {
  const login = act.login.toLowerCase();
  return [...new Set(actors.flatMap((a) => {
    if (a.id === undefined || act.id === undefined) return [a.login];
    if (a.id === act.id) return [login];
    return a.login === login ? [] : [a.login];
  }))].sort();
}

const ROLE_TEXT: Record<OriginRole, string> = { author: 'written', labelled: 'labelled', assigned: 'assigned' };

/** Why an act does not count: by an app or a bot, by nobody the events name, or by a login that is no trusted actor. */
export function untrustedReason(a: OriginActor): string | undefined {
  if (a.trusted) return undefined;
  if (a.app) return `${ROLE_TEXT[a.role]} by an app or a bot (${a.app})`;
  if (!a.login) return `who ${a.role === 'author' ? 'wrote' : a.role === 'labelled' ? 'labelled' : 'assigned'} it is not known`;
  return `${ROLE_TEXT[a.role]} by ${a.login}, not a trusted actor`;
}
