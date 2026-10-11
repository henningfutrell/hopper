// Intake outcomes (issue #440): every open item a job source lists in its scope is taken, or not taken for
// one stated reason, so nothing is dropped without saying why. A claim names its holder (a claim holder id
// per user of a hopper), so a stale claim of the user's own is released and a live one of another hopper is
// respected. The intake migration moves a source's existing items to these rules once, and lists what it changed.
// An item not of a trusted origin (issue #652, intake-origin.ts) is not taken: it is a request card, which a person approves.
import type { ItemText } from './item-snapshots.ts';
import type { AccessAnswer } from './access.ts';
import type { IntakeRequest } from './intake-origin.ts';
import type { ActingPerson } from './failures.ts';

/** What became of one open item in a source's scope. */
export interface IntakeOutcome {
  /** The item's source key (a GitHub issue's URL). */
  key: string;
  title: string;
  /** owner/repo, for a GitHub item. */
  repo?: string;
  /** Absent: taken. Otherwise the one reason it is not. */
  reason?: string;
  /** What the user can do about it from the Sources view. */
  action?: IntakeActionKind;
  /** The item's job, when it was taken and has one (the sync loop fills it). */
  jobId?: string;
  /** A request card (issue #652): what Approve approves. With `action: 'approve'`. */
  request?: IntakeRequest;
}

/**
 * `assign`: assign the item to the user's connected account. `release`: release a claim no job here holds. `approve`:
 * approve a request card's text (issue #652), the one key named, only while its text hashes as `hash`.
 */
export type IntakeActionKind = 'assign' | 'release' | 'approve';

export interface IntakeAction {
  kind: IntakeActionKind;
  keys: string[];
  /** `approve`: the request's hash as the person read it. */
  hash?: string;
  /** `approve`: the person who approved it, as the event names them. */
  acting?: ActingPerson;
}

export interface IntakeActionResult {
  done: string[];
  /** Key → why it was not done. */
  failed: Record<string, string>;
}

/** One change the intake migration made, or one item it found needing the user. */
export interface IntakeChange {
  key: string;
  change: string;
}

/** The intake migration of one source, once done: when, and what it changed. */
export interface IntakeMigration {
  at: string;
  changes: IntakeChange[];
}

/** Repos the connected account can reach, outside the source's scope, with open items for the user there (issue #440). */
export interface OutsideRepo {
  repo: string;
  /** The keys of those items. */
  items: string[];
}

/** The events intake records (issue #440). */
export type IntakeEventType = 'source.claim_released' | 'source.intake_migrated' | 'source.issues_assigned' | 'source.request_approved';

/** What a job source learns for its intake (issue #440), for its own instance name. */
export interface IntakeContext {
  /** This user's claim holder id: random, the same for every source of the user, naming no person or machine. */
  holder: string;
  /** Of these keys, those another user of this hopper has a job for. */
  othersKnown(keys: string[]): Set<string>;
  /** The source's intake migration, once done; undefined until then. */
  migration(): IntakeMigration | undefined;
  migrated(m: IntakeMigration): void;
  record(type: IntakeEventType, data: Record<string, unknown>): void;
}

/** What a job source asks of the user's intake to judge an item's origin (issue #652): kept by the user's store, decided by Access. */
export interface IntakeTrust {
  /**
   * Whether each GitHub login may start the user's jobs (issue #652): Access's answer (OpenFGA), the user's trusted actors
   * told — those named in Settings → Intake, else `connected`. A login denied or not asked is no trusted actor.
   */
  trusted(logins: string[], connected: string): Promise<Map<string, AccessAnswer>>;
  /** The title and body a person approved for the item (an approved request card or accepted new text), or undefined. */
  approvedText(key: string): { title: string; body: string } | undefined;
  /** Record a person's approval of a source's request card: the item's snapshot is its text, and `source.request_approved`. */
  approve(source: string, key: string, text: ItemText, request: IntakeRequest, acting: ActingPerson | undefined): void;
  /** Whether this hopper assigned the item to the user (Sources, Assign to me): that assignment is the user's own act. */
  assignedHere(key: string): boolean;
  /** Whether the item's job waits for its origin (`Job.originPending`, the backfill): its issue is judged though it has a job. */
  originPending(key: string): boolean;
}

/** Access's answer where it cannot be asked: OpenFGA is not set up, so no login is a trusted actor. */
export const NO_INTAKE_ACCESS: AccessAnswer = { allowed: false, reason: 'OpenFGA is not set up: set HOPPER_OPENFGA_URL (docs/deploy.md "Access: OpenFGA")', unavailable: true };

/** Intake with no user store (a host tested alone): nobody is a trusted actor, nothing is approved, nothing can be. */
export const NO_INTAKE_TRUST: IntakeTrust = {
  trusted: async (logins) => new Map(logins.map((l) => [l.toLowerCase(), NO_INTAKE_ACCESS])),
  approvedText: () => undefined,
  approve: () => { throw new Error('no user store keeps approvals here'); },
  assignedHere: () => false,
  originPending: () => false,
};
