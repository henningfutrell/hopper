// Intake outcomes (issue #440): every open item a job source lists in its scope is taken, or not taken for
// one stated reason, so nothing is dropped without saying why. A claim names its holder (a claim holder id
// per user of a hopper), so a stale claim of the user's own is released and a live one of another hopper is
// respected. The intake migration moves a source's existing items to these rules once, and lists what it changed.
// An item not of a trusted origin (issue #652, intake-origin.ts) is not taken: it is a request card, which a person approves.
// Each item not taken is in one not-taken group (issue #798), so the UI groups and counts them by why. An item on the
// backburner says since when and by whom (issue #808), so it never looks dropped. A person may decline a request card
// (issue #1035): its text is kept out until an edit makes it a new request; nothing is written to GitHub.
// An issue reopened after its job was done (issue #1126) is a request card again, with the item's history.
import type { ItemText } from './item-snapshots.ts';
import type { AccessAnswer } from './access.ts';
import type { ActorRef, IntakeRequest, ItemHistory } from './intake-origin.ts';
import type { ActingPerson } from './failures.ts';
import type { JobStatus } from './types.ts';
import type { TaggedRecord } from './tagged.ts';

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
  /** That job's status now, not as of the last sync (issue #798): an ended job's item is taken no more. */
  jobStatus?: JobStatus;
  /** With `reason`: the not-taken group it is in (issue #798). */
  group?: NotTakenGroup;
  /** A request card (issue #652): what Approve approves and Decline declines. With `action: 'approve'`. */
  request?: IntakeRequest;
  /** On the backburner (issue #808): since when and by whom, from its newest `labeled` event. Absent: not read. */
  backburner?: BackburnerSince;
  /** The GitHub work a person's action left after its answer (issue #1194): while it runs, and once it failed. */
  writeBehind?: IntakeWriteBehind;
}

/** An intake action's write-behind: its GitHub work after the answer (issue #1194): running, or failed with why. Absent once it went through. */
export type IntakeWriteBehind = { act: IntakeActionKind; state: 'running' } | { act: IntakeActionKind; state: 'failed'; error: string };

/** When an item went on the backburner, and who put it there (issue #808); a part absent: GitHub did not say. */
export interface BackburnerSince {
  since?: string;
  by?: string;
}

/**
 * Why an item was not taken, as a group (issue #798): a request card waiting for approval, not assigned to the user, on
 * the backburner, its pull request waits for review, partly done, a request a person declined (issue #1035), or any other
 * reason. In this order the UI lists them.
 */
export const NOT_TAKEN_GROUPS = ['request', 'not-assigned', 'backburner', 'pr-waiting', 'partly-done', 'declined', 'other'] as const;
export type NotTakenGroup = typeof NOT_TAKEN_GROUPS[number];

/**
 * `assign`: assign the item to the user's connected account. `release`: release a claim no job here holds. `approve`:
 * approve a request card's text (issue #652), the one key named, only while its text hashes as `hash`. `unbackburner`:
 * take the item off the backburner (issue #798): remove its `hopper:backburner` label. `decline` (issue #1035): decline a
 * request card's text, offered with `approve`, the one key named, only while its text hashes as `hash`; nothing on GitHub.
 * `dismiss` (issue #1141): take **tagged items** the last sync listed off Tagged, for the reasons they have now; nothing on
 * GitHub. `take_in` (issue #1176, Take into Intake): give an issue no work item, that an untracked pull request the last
 * census listed closes, the source's label and assign it to the user's connected account, so the next sync lists it in
 * Intake.
 */
export type IntakeActionKind = 'assign' | 'release' | 'approve' | 'unbackburner' | 'decline' | 'dismiss' | 'take_in';

export interface IntakeAction {
  kind: IntakeActionKind;
  keys: string[];
  /** `approve`, `decline`: the request's hash as the person read it. */
  hash?: string;
  /** `approve`, `decline`: the person who did it, as the event names them. */
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
export type IntakeEventType = 'source.claim_released' | 'source.intake_migrated' | 'source.issues_assigned' | 'source.request_approved'
  | 'source.request_opened' | 'source.backburner_lifted' | 'source.request_declined' | 'source.request_withdrawn' | 'source.review_requested'
  | 'source.issue_taken_in';

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
  /**
   * Whether `source.request_opened` was recorded for this item with this text's hash (issue #798), and no
   * `source.request_withdrawn` since (issue #1067, part 4): each text opens once while it stays in Intake.
   */
  requestOpened(key: string, hash: string): boolean;
  /** The keys of this source's request cards the work-item ledger has waiting for approval (issue #1067, part 4). */
  requestsWaiting(): string[];
  /** The item's jobs here and its pull request (issue #1126): a reopened card's history. Undefined: no job here. */
  history?(key: string): ItemHistory | undefined;
  /** What the source keeps of its **tagged items** between reads (issue #1141), in the user's settings. Absent: kept in memory. */
  tagged?: { get(): TaggedRecord | undefined; set(record: TaggedRecord): void };
  /**
   * Whether the item waits on its batch (issue #1175, `awaitsBatch`): its pull request merged into the landing branch, and
   * its issue stays open until the batch run reaches the tested branch. It is no reopened card.
   */
  awaitsBatch?(key: string): boolean;
}

/**
 * Whether one item's `source.request_opened` with this hash is in `events` (oldest first) after its last
 * `source.request_withdrawn` or `source.request_approved` (issues #1067 part 4, #1126): a card back in Intake opens again,
 * and so does a reopened item's card of a text approved before.
 */
export function requestOpenedSince(events: readonly { type: string; data: Record<string, unknown> }[], hash: string): boolean {
  const from = events.findLastIndex((e) => e.type === 'source.request_withdrawn' || e.type === 'source.request_approved') + 1;
  return events.slice(from).some((e) => e.type === 'source.request_opened' && e.data.hash === hash);
}

/** How many of an item's jobs a reopened card names. */
const HISTORY_JOBS = 10;

/** An item's history (issue #1126): `newest` and the jobs it ran again (`rerunOf`), at most ten, and its pull request. */
export function itemHistory(newest: { id: string; status: string; rerunOf?: string } | undefined,
  get: (id: string) => { id: string; status: string; rerunOf?: string } | undefined, pullRequest?: string): ItemHistory | undefined {
  if (!newest) return undefined;
  const jobs: ItemHistory['jobs'] = [];
  const seen = new Set<string>();
  let j: typeof newest | undefined = newest;
  while (j && jobs.length < HISTORY_JOBS && !seen.has(j.id)) {
    seen.add(j.id);
    jobs.push({ id: j.id, status: j.status });
    j = j.rerunOf ? get(j.rerunOf) : undefined;
  }
  return { jobs, ...(pullRequest ? { pullRequest } : {}) };
}

/** What a job source asks of the user's intake to judge an item's origin (issue #652): kept by the user's store, decided by Access. */
export interface IntakeTrust {
  /**
   * Whether each who did an act may start the user's jobs (issue #652), by lowercased login: Access's answer (OpenFGA), the
   * user's trusted actors told — those named in Settings → Intake, by GitHub user id (issue #930), else `connected`. A
   * login denied or not asked is no trusted actor.
   */
  trusted(acts: ActorRef[], connected: string): Promise<Map<string, AccessAnswer>>;
  /** The title and body a person approved for the item (an approved request card or accepted new text), or undefined. */
  approvedText(key: string): { title: string; body: string } | undefined;
  /** Record a person's approval of a source's request card: the item's snapshot is its text, and `source.request_approved`. */
  approve(source: string, key: string, text: ItemText, request: IntakeRequest, acting: ActingPerson | undefined): void;
  /**
   * The comments the job would see, read after the approval (issue #1194), added to the item's approved snapshot; nothing
   * when its snapshot is no longer the approved one.
   */
  approvedComments(key: string, comments: ItemText['comments']): void;
  /** Whether a person declined the item's request card with this text's hash (issue #1035). */
  declined(key: string, hash: string): boolean;
  /** Record a person's decline of a source's request card (issue #1035): `source.request_declined`, with its hash. */
  decline(source: string, key: string, request: IntakeRequest, acting: ActingPerson | undefined): void;
  /** Whether this hopper assigned the item to the user (Sources, Assign to me): that assignment is the user's own act. */
  assignedHere(key: string): boolean;
  /** Whether the item's job waits for its origin (`Job.originPending`, the backfill): its issue is judged though it has a job. */
  originPending(key: string): boolean;
}

/** Access's answer where it cannot be asked: OpenFGA is not set up, so no login is a trusted actor. */
export const NO_INTAKE_ACCESS: AccessAnswer = { allowed: false, reason: 'OpenFGA is not set up: set HOPPER_OPENFGA_URL (docs/deploy.md "Access: OpenFGA")', unavailable: true };

/** Intake with no user store (a host tested alone): nobody is a trusted actor, nothing is approved, nothing can be. */
export const NO_INTAKE_TRUST: IntakeTrust = {
  trusted: async (acts) => new Map(acts.map((a) => [a.login.toLowerCase(), NO_INTAKE_ACCESS])),
  approvedText: () => undefined,
  approve: () => { throw new Error('no user store keeps approvals here'); },
  approvedComments: () => undefined,
  declined: () => false,
  decline: () => { throw new Error('no user store keeps declines here'); },
  assignedHere: () => false,
  originPending: () => false,
};
