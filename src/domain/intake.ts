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
import type { AutoApproval, IntakeAutoApproval } from './intake-auto-approve.ts';
import type { DeclineChoice, IntakeDeclineDefaults } from './intake-decline.ts';
import type { ActingPerson } from './failures.ts';
import type { JobStatus } from './types.ts';
import type { TaggedRecord } from './tagged.ts';
import type { WorkItem } from './work-items.ts';

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
  /** Its **arrival** (issue #2228): when the hopper first listed the item, ISO 8601. Kept in the store, never reset by a sync or a restart. */
  arrivedAt?: string;
}

/** Each item's **arrival** in a source's intake (issue #2228), in the user's store: the first time the source listed it. */
export interface IntakeArrivalRepository {
  /** The arrival of each of `keys` in `source`: a key the source never listed before arrives `at`; one listed before keeps its arrival. */
  arrive(source: string, keys: readonly string[], at: string): Map<string, string>;
}

/** The outcomes, each with its arrival when one is known (issue #2228). */
export const withArrivals = (outcomes: readonly IntakeOutcome[], arrivals: ReadonlyMap<string, string>): IntakeOutcome[] =>
  outcomes.map((x) => { const at = arrivals.get(x.key); return at === undefined ? x : { ...x, arrivedAt: at }; });

/**
 * An intake action's write-behind: its rows in the GitHub outbox (issues #1194, #1238): running, or failed with why. Absent
 * once it went through. While the outbox tries it again by itself (part 8): `attempt`, and `error`, why GitHub refused the try before.
 */
export type IntakeWriteBehind =
  | { act: IntakeActionKind; state: 'running'; attempt?: number; error?: string }
  | { act: IntakeActionKind; state: 'failed'; error: string };

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
 * request card's text, offered with `approve`, the one key named, only while its text hashes as `hash`; its `choice`
 * (issue #1710) closes the issue or leaves it open, each without the source's label, and a comment says so.
 * `dismiss` (issue #1141): take **tagged items** the last sync listed off Tagged, for the reasons they have now; nothing on
 * GitHub. `take_in` (issue #1176, Take into Intake): give an issue no work item, that an untracked pull request the last
 * census listed closes, the source's label and assign it to the user's connected account, so the next sync lists it in
 * Intake. `retry_outbox` (issue #1238, a Retry on Sources): send the item's failed rows of the GitHub outbox again.
 * `wont_do` (issue #1891): drop an item the ledger holds blocked; its blocked label goes and `hopper:rejected` comes on.
 */
export type IntakeActionKind = 'assign' | 'release' | 'approve' | 'unbackburner' | 'decline' | 'dismiss' | 'take_in' | 'retry_outbox' | 'wont_do';

export interface IntakeAction {
  kind: IntakeActionKind;
  keys: string[];
  /** `approve`, `decline`: the request's hash as the person read it. */
  hash?: string;
  /** `approve`, `decline`, `wont_do`: the person who did it, as the event names them. */
  acting?: ActingPerson;
  /** `decline` (issue #1710): close the issue or leave it open; absent: the user's default for the card. */
  choice?: DeclineChoice;
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

/**
 * The events intake records (issue #440); `work_item.issue_closed`: the close of a promoted item's issue (issue #1232);
 * `work_item.dropped`: a person's Won't do on a blocked item (issue #1891).
 */
export type IntakeEventType = 'source.claim_released' | 'source.intake_migrated' | 'source.issues_assigned' | 'source.request_approved'
  | 'source.request_opened' | 'source.backburner_lifted' | 'source.request_declined' | 'source.request_decline_written' | 'source.request_withdrawn' | 'source.review_requested'
  | 'source.issue_taken_in' | 'work_item.issue_closed' | 'work_item.dropped' | 'work_item.label_edited';

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
  /**
   * Whether the item is done by a pull request its batch run promoted to the tested branch, its issue still open (issue
   * #1232, `promotedOpen`): the sync closes the issue, once, and it is no reopened card.
   */
  promotedOpen?(key: string): boolean;
  /** The work item of an issue, by its URL (issue #1891): its end labels mirror its state (the label mirror). Absent: none is compared. */
  workItem?(key: string): WorkItem | undefined;
  /** Whether the open pull request of an item in PR open is a part (issue #1933): its waiting label is then `hopper:partly-done`. */
  partOpen?(key: string): boolean;
  /**
   * Whether the failure of a failed item's job was reported to its issue as failed (issue #1892): `hopper:failed` is then its
   * label. Not while the hopper fixes it itself (issue #1230), or its report waits.
   */
  failureReported?(key: string): boolean;
  /**
   * Whether a partly done item's merged part leaves parts to run (issue #1892): the follow recorded the merge of a part, and
   * not every declared part is done. It then carries no end label, and Intake takes it again for its next part.
   */
  partsLeft?(key: string): boolean;
}

/**
 * Whether one item's `source.request_opened` with this hash is in `events` (oldest first) after its last
 * `source.request_withdrawn` or `source.request_approved` (issues #1067 part 4, #1126): a card back in Intake opens again,
 * and so does a reopened item's card of a text approved before.
 */
export function requestOpenedSince(events: readonly { type: string; data: Record<string, unknown> }[], hash: string): boolean {
  const from = events.findLastIndex((e) => e.type === 'source.request_withdrawn' || e.type === 'source.request_approved' || e.type === 'source.request_auto_approved') + 1;
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
  /** The user's auto-approval setting (issue #1268); absent: off. */
  autoApproval?(): IntakeAutoApproval;
  /**
   * Record the hopper's approval of a request card a rule matched (issue #1268): the item's snapshot is its text, as a
   * person's approval keeps it, and `source.request_auto_approved` names the rule and the actor.
   */
  autoApprove?(source: string, key: string, text: ItemText, request: IntakeRequest, approval: AutoApproval): void;
  /** Whether a person took the item into Intake (issue #1176): it stays a request card, never auto-approved (issue #1268). */
  takenIn?(key: string): boolean;
  /**
   * The comments the job would see, read after the approval (issue #1194), added to the item's approved snapshot; nothing
   * when its snapshot is no longer the approved one.
   */
  approvedComments(key: string, comments: ItemText['comments']): void;
  /**
   * Whether a person declined the item's request card with this text's hash (issue #1035): until GitHub took the decline's
   * writes (issue #1710), then GitHub's labels and state are the record. A decline with no choice (before issue #1710, or
   * on GitLab) holds until an edit.
   */
  declined(key: string, hash: string): boolean;
  /** Record a person's decline of a source's request card (issue #1035): `source.request_declined`, with its hash and `choice` (issue #1710). */
  decline(source: string, key: string, request: IntakeRequest, acting: ActingPerson | undefined, choice?: DeclineChoice): void;
  /** The user's decline defaults (issue #1710); absent: `DEFAULT_INTAKE_DECLINE`. */
  declineDefaults?(): IntakeDeclineDefaults;
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
