// The store's ports (design.md "Database", "Users: one hopper, separate users"): the repositories, a
// user's store and the instance store. Re-exported from ports.ts.

import type { JobStreamRepository } from './job-stream.ts';
import type { ArtifactRepository } from './artifacts.ts';
import type { VaultRepository } from './vault.ts';
import type { SandboxRecord } from './sandboxes.ts';
import type { VaultGrant } from './vault-grants.ts';
import type { BugReportRepository } from './bug-reports.ts';
import type { InstanceSettingsRepository, UserSettingsRepository } from './settings-store.ts';
import type { DomainEvent, Decision, EventType, Job, JobId, JobSpec, JobStatus, Lane, JobSourceRef, LaneId, MachineId, NewEvent, Question, QuestionAttempt, QuestionStatus, RaisedBy, ReviewEntry, ReviewItem, ReviewKind, ReviewStatus, ReviewVersion, PhaseSuggestion, ProposalPathSet,
  Identity, Login, LoginStatus, SessionLengths, UiRole, WebhookDelivery, WebhookSubscription, User, UsageSample, UsageSeries, UsageTotalSeries, GitHubWatchRepository, PointedJobRepository, FailureOutcome, FailureRecord, Handoff, Problem, ConnectedAccountKey, ConnectedAccountProvider, JobRun, LaneLoad, MachineSample, ResourcePressure, ResourceSeries, ItemSnapshot, AccessRepository, CheckpointRepository } from './types.ts';

// Report a bug (issue #694): its repository sits beside its record.
export type { BugReportRepository } from './bug-reports.ts';

export type { InstanceSettingsRepository, UserSettingsRepository } from './settings-store.ts';
export type { VaultRepository } from './vault.ts';

// ---- Persistence -----------------------------------------------------------------------

export interface JobFilter {
  status?: JobStatus[];
  /** Only the jobs with no failure assessment (issue #517). */
  unassessed?: boolean;
  /** Only the jobs whose pull request is followed, open or closed without a merge (issue #637: the Pull requests list), or handed to a tend job (issue #763). */
  followed?: boolean;
  /** `undismissed`: only the jobs no one dismissed (`dismissedAt` unset, issue #1123). `namesPullRequest`: only the jobs that name a pull request not merged nor abandoned, followed or not (issue #1143). */
  limit?: number; undismissed?: boolean; namesPullRequest?: boolean;
}

export interface JobRepository {
  /**
   * A new queued job. With the stamp key (`useStampKey`), it is stamped by the rules (issue #655); `parent`: a job made it,
   * and it gets at most its parent's verified level, never `owner`, or no stamp when its parent's does not verify.
   */
  create(spec: JobSpec, priority: number, source?: JobSourceRef, parent?: Job): Job;
  /**
   * `lockItem`: holds item `key`'s jobs to this transaction until it ends (issue #1892): of two hoppers that make a new job
   * of one item at once, the second reads the first's. Absent: one hopper (a test's store).
   */
  get(id: JobId): Job | undefined; getBySourceKey(key: string): Job | undefined; list(filter?: JobFilter): Job[]; lockItem?(key: string): void;
  /**
   * Many jobs in one read (issue #1411), so a pass over many jobs reads none one by one: `getMany` the jobs of `ids` that
   * exist; `newestOfItems` the newest job of each item (source key) of `keys` that has one, as `getBySourceKey`;
   * `idsOfItem` the ids of every job of item `key`, newest first, no body read (issue #2319).
   */
  getMany(ids: readonly JobId[]): Map<JobId, Job>; newestOfItems(keys: readonly string[]): Map<string, Job>; idsOfItem(key: string): JobId[];
  /** Shallow-merge patch; a key present with value `undefined` clears that field. Bumps updatedAt. */ update(id: JobId, patch: Partial<Omit<Job, 'id' | 'spec' | 'createdAt' | 'stamp'>>): Job;
  /** Replace the spec of a job that has not started (issue #375); stamped again at its verified level or lower (issue #655). Bumps updatedAt. */
  respecify(id: JobId, spec: JobSpec): Job;
  /**
   * Trust stamps (issue #655). `useStampKey`: the user's stamp key, given once at the start: from then each job made is
   * stamped; it stamps, by the rules, each job that has not ended and has no stamp (the backfill), and answers their ids.
   * `stampHold`: why the job's stamp holds it; undefined: it may start, or the store has no stamp key. `restamp`: the job
   * stamped again by the rules, for an origin judged after it was made (issue #652, the backfill); a quarantine stays.
   * Quarantine: `quarantine` stamps the job `quarantined`, its level before kept; `liftQuarantine` gives that level back
   * (the rules' with none). `trustLevel`: its verified level. `opensDoors`: its proxy token opens the hopper's doors.
   * Jev's trust check (part 4): `checkDue`, the job is due for it; `checkTrust`, the stamp after Jev's answer, the point
   * active — undefined, and nothing written, when the check is no longer due; `approveTrust`, a person approves the trust
   * of a job the check (or a deny) lowered, to `approved` — undefined when it may not. `deny` (part 5): a person's deny at
   * gate 2 lowers the job's level one step, the second quarantines it — undefined, and nothing written, when it ended, is
   * quarantined already, or its stamp does not verify. `edited` (part 7): a sync saw the item of the started job edited, so
   * its level drops to `untrusted` — undefined, and nothing written, when it ended, is at `untrusted` or lower already, or
   * its stamp does not verify. `gate2Hold` (parts 7, 12): why gate 2 asks a person for each of the job's requests — its
   * stamp does not verify, or is below `approved` or the level `brake` needs; undefined, the store has no stamp key too.
   */
  useStampKey(key: Buffer): string[]; stampHold(job: Job, brake?: import('./intake-strictness.ts').Brake): string | undefined; stampView(job: Job, brake: import('./intake-strictness.ts').Brake): import('./stamp-view.ts').StampView; restamp(id: JobId): Job; quarantine(id: JobId): Job; liftQuarantine(id: JobId): Job; trustLevel(job: Job): import('./trust-stamp.ts').TrustLevel | undefined; opensDoors(job: Job): boolean; gate2Hold(job: Job, brake: import('./intake-strictness.ts').Brake): string | undefined; edited(id: JobId): Job | undefined; checkDue(job: Job): boolean; checkTrust(id: JobId, out: import('./minor-decisions.ts').MinorDecisionOutcome): Job | undefined; approveTrust(id: JobId): Job | undefined; deny(id: JobId, by?: 'person' | 'jev'): Job | undefined;
}

export interface LaneRepository {
  list(machineId?: MachineId): Lane[];
  /** Opens the lane `id` names when it is the machine's and free (issue #535), else the lowest free lane number. */
  open(machineId: MachineId, id?: LaneId): Lane;
  update(id: LaneId, patch: Partial<Omit<Lane, 'id' | 'machineId' | 'openedAt'>>): Lane;
  close(id: LaneId): void;
}

export interface DecisionRepository {
  save(decision: Decision): void;
  get(id: string): Decision | undefined;
  /** Newest first. */
  list(limit?: number): Decision[];
}

/**
 * Append-only event log. append assigns seq/id/at. Listeners are notified only after the
 * OUTERMOST transaction commits (immediately when no transaction is open), and never for a
 * rolled-back append. Listeners must not re-enter the engine synchronously — schedule work
 * with setImmediate/queueMicrotask.
 */
export interface EventLog {
  append(event: NewEvent): DomainEvent;
  /** Events with seq > afterSeq, oldest first. */
  since(afterSeq: number, limit?: number): DomainEvent[];
  /** Newest first; one job's alone when `jobId` names it (issue #935: the job page's timeline and parts list). */
  recent(limit?: number, types?: EventType[], jobId?: string): DomainEvent[];
  /** Events of these types at or after `since` (ISO), oldest first (issue #535: lane reliability). */
  between(types: readonly EventType[], since: string): DomainEvent[];
  /** The newest event of each of these jobs that has one, one per job (issue #434: the Jobs view's last event). */
  lastOfJobs(jobIds: readonly string[]): DomainEvent[];
  subscribe(listener: (event: DomainEvent) => void): () => void;
}

/**
 * The instance's events (`update.*`, `plugin.installed`, `plugin.removed`): appended to every user's
 * event log, the newest read from the first user's. With no user yet (issue #238) they are kept nowhere.
 */
export interface InstanceEvents {
  append(event: NewEvent): void;
  recent(limit?: number, types?: EventType[]): DomainEvent[];
}

export interface WebhookRepository {
  /** A new subscription; undefined (nothing written) when the name is taken. The table is the source of truth (issue #78). */
  add(input: { name: string; url: string; events: string[]; active: boolean }): WebhookSubscription | undefined;
  /** Changes only the fields given; undefined when there is no such subscription. */
  update(id: string, patch: { url?: string; events?: string[]; active?: boolean }): WebhookSubscription | undefined;
  /**
   * Records that the subscription's signing secret was kept in the vault (issue #658), with when it changed (default
   * now): its runtime variable is no longer read, and its copy from before #658 goes. Undefined when there is no such subscription.
   */
  secretKept(id: string, changedAt?: string): WebhookSubscription | undefined;
  /** The signing secret a subscription kept sealed in its row before issue #658, for the move into the vault; undefined: none. */
  legacySecret(id: string): string | undefined;
  get(id: string): WebhookSubscription | undefined;
  list(): WebhookSubscription[];
  /** Deletes the subscription and marks its pending/retrying deliveries `failed`. */
  delete(id: string): boolean;
  /** status `pending`, attempts 0, nextAttemptAt = now. */
  createDelivery(subscriptionId: string, event: DomainEvent): WebhookDelivery; hasDelivery(subscriptionId: string, eventSeq: number): boolean; // a delivery of the event with this seq: one handed again at a catch-up (issue #1572)
  updateDelivery(id: string, patch: Partial<Omit<WebhookDelivery, 'id' | 'subscriptionId' | 'eventSeq' | 'eventType' | 'createdAt'>>): WebhookDelivery;
  /**
   * `dueDeliveries`: the deliveries due at or before `now` (status pending|retrying and nextAttemptAt <= now).
   * `claimDelivery` claims a due delivery for one attempt (issue #1627): compare-and-set, its nextAttemptAt moved to `until`
   * only while it is still due at `now`, so of two hosts that ask at once one gets it. The claimed delivery, else undefined.
   */
  dueDeliveries(now: Date): WebhookDelivery[]; claimDelivery(id: string, now: Date, until: string): WebhookDelivery | undefined;
  listDeliveries(filter?: { subscriptionId?: string; limit?: number }): WebhookDelivery[];
}

export interface QuestionRepository {
  /** `tier`: the stage it starts at (the first escalation level's instance name, or `human`). */
  create(input: { jobId: JobId; text: string; recentOutput: string; detectedBy: string; tier: string; lapsesAt?: string; raisedBy?: RaisedBy; suggestion?: PhaseSuggestion }): Question;
  get(id: string): Question | undefined;
  /** Newest first. */
  /** By creation: `newest-first` (the default; a history) or `oldest-first` (the open questions, the longest waiting first; issue #450). A limit keeps the first of that order. */
  list(filter?: { status?: QuestionStatus[]; jobId?: JobId; limit?: number; order?: 'oldest-first' | 'newest-first' }): Question[];
  /** Shallow-merge; `undefined` clears. Bumps updatedAt. */
  update(id: string, patch: Partial<Omit<Question, 'id' | 'jobId' | 'createdAt' | 'attempts'>>): Question;
  /**
   * Append one attempt to the question's trail. `finishAttempt`: replace the attempt of `callKey` (issue #1608) with
   * `attempt`, which keeps the key; none of that key: append it.
   */
  addAttempt(id: string, attempt: QuestionAttempt): Question; finishAttempt(id: string, callKey: string, attempt: QuestionAttempt): Question;
}

/** One review section's items (issues #537, #543): one per job and kind, its versions and review trail in it. */
export interface ReviewItemRepository {
  create(input: { jobId: JobId; stage: string; version: ReviewVersion; raisedBy?: RaisedBy; source?: ReviewItem['source']; forkOf?: ReviewItem['forkOf']; switchedFrom?: ReviewItem['switchedFrom'] }): ReviewItem;
  get(id: string): ReviewItem | undefined;
  /** By creation: `newest-first` (the default; a history) or `oldest-first` (the open ones, the longest waiting first). */
  list(filter?: { status?: ReviewStatus[]; jobId?: JobId; limit?: number; order?: 'oldest-first' | 'newest-first' }): ReviewItem[];
  /** Shallow-merge; `undefined` clears. Bumps updatedAt. */
  update(id: string, patch: Partial<Omit<ReviewItem, 'id' | 'kind' | 'jobId' | 'createdAt' | 'reviews' | 'versions'>>): ReviewItem;
  addReview(id: string, review: ReviewEntry): ReviewItem;
  addVersion(id: string, version: ReviewVersion): ReviewItem;
  /** A proposal's newest version with its paths amended by a reviewer level (issue #651). */
  setPaths(id: string, paths: ProposalPathSet): ReviewItem;
}

/** Logins (issue #476): what the hopper keeps of each, never its URL or code. */
export interface LoginRepository {
  create(input: Omit<Login, 'id' | 'status' | 'createdAt' | 'updatedAt'>): Login;
  get(id: string): Login | undefined;
  /** Newest first. */
  list(filter?: { status?: LoginStatus[]; jobId?: JobId; questionId?: string; limit?: number }): Login[];
  /** Shallow-merge; `undefined` clears. Bumps updatedAt. */
  update(id: string, patch: Partial<Omit<Login, 'id' | 'createdAt'>>): Login;
}

/** The failure records (issue #509): one per assessed failed job. */
export interface FailureRepository {
  create(input: Omit<FailureRecord, 'id'>): FailureRecord;
  get(id: string): FailureRecord | undefined;
  /** The job's newest record. */
  forJob(jobId: JobId): FailureRecord | undefined;
  /**
   * Newest first: of a job, since a time, of a signature, of a problem, with one of the outcomes, with none of
   * `notOutcome` (no outcome yet counts as none); at most `limit` (default 1000).
   */
  list(filter?: { jobId?: JobId; since?: string; signature?: string; problemId?: string; outcome?: FailureOutcome[]; notOutcome?: FailureOutcome[]; limit?: number }): FailureRecord[];
  /** The records whose pending run is due at `at`, the earliest first. */
  due(at: string): FailureRecord[];
  /** Shallow-merge; `undefined` clears. */
  update(id: string, patch: Partial<Omit<FailureRecord, 'id' | 'jobId'>>): FailureRecord;
  /** Delete the records older than `before` with no pending run; how many. */
  prune(before: string): number;
}

/** The hand-offs (issue #516): failed jobs waiting on a person. */
/** The vault grants (issue #652), one row per item key: a person's grant of the vault to that item's jobs. */
export interface VaultGrantRepository {
  get(key: string): VaultGrant | undefined;
  list(): VaultGrant[];
  put(grant: VaultGrant): VaultGrant;
  /** Whether there was one to remove. */
  remove(key: string): boolean;
}

/** The approved text of each source item (issue #662), one row per item key: the newest snapshot replaces the one before. */
export interface ItemSnapshotRepository {
  get(key: string): ItemSnapshot | undefined;
  /** Record `snapshot` as its item's approved text, in place of any before it. */
  put(snapshot: ItemSnapshot): ItemSnapshot;
}

export interface HandoffRepository {
  create(input: Omit<Handoff, 'id'>): Handoff;
  get(id: string): Handoff | undefined;
  /** The job's newest hand-off. */
  forJob(jobId: JobId): Handoff | undefined;
  /** Open ones oldest first; closed ones newest closed first; at most `limit` (default 500). */
  list(filter: { status: Handoff['status']; closedSince?: string; limit?: number }): Handoff[];
  /** Shallow-merge; `undefined` clears. */
  update(id: string, patch: Partial<Omit<Handoff, 'id' | 'jobId'>>): Handoff;
  /** Delete the hand-offs closed before `before`, never an open one; how many. */
  prune(before: string): number;
}

/** The problems (issue #509): shared causes, one per signature while open. */
export interface ProblemRepository {
  create(input: Omit<Problem, 'id'>): Problem;
  get(id: string): Problem | undefined;
  /** The open problem of a signature. */
  open(signature: string): Problem | undefined;
  /** Newest first; at most `limit` (default 200). */
  list(filter?: { status?: Problem['status']; since?: string; limit?: number }): Problem[];
  /** Shallow-merge; `undefined` clears. */
  update(id: string, patch: Partial<Omit<Problem, 'id'>>): Problem;
  /** Delete the problems resolved before `before`; how many. */
  prune(before: string): number;
}


/** What the usage graph reads: a stretch, its graph step, and the time steps are counted from (a local midnight, a Monday). */
export interface UsageHistoryQuery {
  from: Date;
  to: Date;
  stepMs: number;
  originMs: number;
  /** Only the usage that limits this machine: its own readings and those of a budget every machine shares (issue #688). */
  limiting?: string;
}

/** One user's lines of one unit and usage window, summed per graph step: summed again over every user for the instance usage totals. */
export interface UsageTotalSum extends Omit<UsageTotalSeries, 'points'> {
  points: { at: string; used: number; limit: number; series: number }[];
}

/** The usage history (issue #385): usage samples in the user schema. */
export interface UsageHistoryRepository {
  /** Keep readings as usage samples; one already kept (same source, machine, usage window and time) is kept once. How many were new. */
  record(samples: readonly UsageSample[]): number;
  /** The usage graph's lines over [from, to), ordered by source, machine and usage window. */
  series(q: UsageHistoryQuery): UsageSeries[];
  /** The lines summed per unit and usage window, nothing named: this user's share of the instance usage totals. */
  totals(q: UsageHistoryQuery): UsageTotalSum[];
  /** Delete the samples older than `before`; how many. */
  prune(before: Date): number;
}

/** The resource graph's query (issue #560): the usage graph's, and the one machine when it asks for one. */
export interface MachineHistoryQuery extends Omit<UsageHistoryQuery, 'limiting'> {
  machineId?: string;
}

/** Machine resources over time (issue #560): machine samples in the user schema. */
export interface MachineHistoryRepository {
  /** Keep machine samples; one already kept (same machine and time) is kept once. How many were new. */
  record(samples: readonly MachineSample[]): number;
  /** The resource graph's lines over [from, to), ordered by machine and resource. */
  series(q: MachineHistoryQuery): ResourceSeries[];
  /** Lane load over [from, to): per machine and lanes in use, ordered by machine and lanes in use (issue #688). */
  laneLoad(q: { from: Date; to: Date; pressure: ResourcePressure }): LaneLoad[];
  /** The job runs that ended in [from, to), with what the machine and usage samples in each show (issue #688); `jobId`: one job's only (issue #935 part 2). */
  jobRuns(q: { from: Date; to: Date; jobId?: string }): JobRun[];
  /** Delete the samples older than `before`; how many. */
  prune(before: Date): number;
}


/** A stored UI session: never the token, only its SHA-256; the user it acts for (issue #158). */
/**
 * A stored UI session (issue #439): when it started, when a request last renewed it, and when a gateway realm's
 * token last checked out for it (its start, for every other realm). How long it lasts is the sign-in config's,
 * read at each lookup; `endsAt` is a fixed end of its own (the operator CLI's sessions), absent for every other.
 */
export interface UiSessionRow {
  tokenHash: string; startedAt: string; lastSeenAt: string; checkedAt: string; endsAt?: string;
  role: UiRole; identity: Identity; userId: string;
  /** An API token (issue #718) and its label; absent: a UI session. `box`: a box token (issue #795). */
  /** `grantId`: the grant an API token was refreshed from (issue #881); absent: no grant's (an exchange, or minted before). */
  kind?: 'api'; label?: string; box?: true; grantId?: string;
}

/** UI sessions, keyed by the SHA-256 of the token; the token itself is never stored. Which have ended is the caller's to decide. */
export interface UiSessionRepository {
  /** `expiresAt`: the session's absolute end as it is now, for the build before store migration 27 to read (issue #527); never read back. */
  create(row: UiSessionRow, expiresAt: string): void;
  /** The session with this hash, ended or not, or undefined. */
  get(tokenHash: string): UiSessionRow | undefined;
  /** Every stored session, ended or not. */
  all(): UiSessionRow[];
  setRole(tokenHash: string, role: UiRole): void;
  /** Renewed at `lastSeenAt`; `checkedAt` too when given (a gateway token that checked out). */
  touch(tokenHash: string, lastSeenAt: string, checkedAt?: string): void;
  drop(tokenHash: string): void;
}

/** One-time UI login codes, keyed by the SHA-256 of the code; the code itself is never stored. Each is for one user. */
export interface LoginCodeRepository {
  create(codeHash: string, expiresAt: string, userId: string): void;
  /** The code's user, and the code is gone, when it exists and `expiresAt > now`; else undefined. Expired codes are deleted first. */
  take(codeHash: string, now: string): string | undefined;
  /** The code's user when it exists and `expiresAt > now`; the code stays. */
  live(codeHash: string, now: string): string | undefined;
}

/** One-time join codes (issue #308): only each code's SHA-256 is kept, with its user and expiry. */
/**
 * What a join code names beside its user: the template the machine joins as (issue #558), when the line names one;
 * the sandbox box the hopper launched with it (issue #603), when it did; the job pod it started with it (issue #1283).
 */
export interface JoinCodePlace { template?: string; pod?: string }

export interface JoinCodeRepository {
  create(codeHash: string, expiresAt: string, userId: string, place?: JoinCodePlace): void;
  /**
   * The code's user (and what it names), when it exists and `expiresAt > now`: the code is spent by `machineKey`, and
   * taken again by that key only, until it expires (issue #1628: a join whose answer was lost is sent again). Else
   * undefined. Expired codes are deleted first.
   */
  take(codeHash: string, now: string, machineKey: string): ({ userId: string } & JoinCodePlace) | undefined;
}

/** The sandbox records (issue #708, instance migration 34): one per sandbox box an older build launched, by id; names are unique. */
export interface SandboxRepository {
  list(): SandboxRecord[];
  /** False when a record of that id or name exists. A record of a box an older build launched: a test's, the hopper adds none (issue #1349). */
  add(record: SandboxRecord): boolean;
  remove(id: string): boolean;
}

/**
 * The config records the store holds (design.md "Config in the database", issue #198): a user's
 * `plugins`, `rules`, `job-rules`, `repo-job-rules` (issue #1472), `repo-memory` (issue #2847), `windows-hosts` (issue #731), `clusters` (issue #1766) and `podman-hosts` (issue #2272), and the instance's `sign-in`. No config lives in a file.
 */
export const USER_CONFIG = ['plugins', 'rules', 'job-rules', 'repo-job-rules', 'repo-memory', 'windows-hosts', 'clusters', 'podman-hosts'] as const;
export const INSTANCE_CONFIG = ['sign-in'] as const;
export const CONFIG_NAMES = [...USER_CONFIG, ...INSTANCE_CONFIG] as const;
export type UserConfigName = (typeof USER_CONFIG)[number];
export type InstanceConfigName = (typeof INSTANCE_CONFIG)[number];
export type ConfigName = (typeof CONFIG_NAMES)[number];

/**
 * Config records: named JSON values, each replaced whole against its `version` — the sha-256 of its
 * JSON, or `missing` while there is none.
 */
export interface ConfigRecords<N extends string = UserConfigName> {
  /** The value, or undefined while there is none. */
  read(name: N): unknown;
  version(name: N): string;
  /** Replace the value if the record is still at `version`; false (nothing written) when it moved. */
  write(name: N, value: unknown, version: string): boolean;
}

/** The users of this hopper (issue #158), oldest first. */
export interface UserRepository {
  list(): User[];
  get(id: string): User | undefined;
  /** A new user under a unique name (throws when taken): its row and its user schema. `email`: the verified email it is known by. */
  add(name: string, email?: string): User;
  /** The user known by this email (issue #1380), compared in lowercase. */
  byEmail(email: string): User | undefined;
  /** The user is known by this email from now on, lowercase; throws when another user has it. */
  setEmail(id: string, email: string): void;
  /**
   * `to` takes over `from`'s work (issue #212): `to`'s sign-ins, sessions and login codes move onto
   * `from`'s record, which takes `to`'s name; `to`'s record and user schema are removed. Throws, nothing
   * changed, when `to` holds work of its own (jobs, questions, decisions, webhooks). The record kept.
   */
  transfer(fromId: string, toId: string): User;
  /**
   * `from` is folded into `into` and is gone (issue #265): `into` keeps its id and name, on `from`'s
   * record — its place, work dir, secret prefix and user schema, so `from`'s work runs on untouched — and
   * `into`'s work, sign-ins, sessions and login codes join it (`src/store/fold-user.ts`). The record kept.
   */
  fold(fromId: string, intoId: string): User;
}

/** Which user an identity signs in as (`user_identities`). */
export interface IdentityLinks {
  userOf(realm: string, subject: string): string | undefined;
  /** Link the identity to the user; an existing link is kept. */
  link(realm: string, subject: string, userId: string): void;
  /** True when an identity of one of these realms is linked to a user: someone has signed in with it. */
  anyIn(realms: readonly string[]): boolean;
  /** Every identity linked to a user: everyone who has signed in, by realm and subject. */
  all(): { realm: string; subject: string; userId: string }[];
}

/**
 * One realm as stored: its name, type, label (absent: its name), `enabled: false` when off, and the
 * settings of its type (src/auth/config.ts checks them).
 */
export type StoredRealm = { name: string; type: string; label?: string; enabled?: boolean } & { [setting: string]: unknown };

/**
 * The sign-in config as stored (design.md "Sign-in: realms", issue #198): the config record `sign-in`
 * — the value src/auth/config.ts loads.
 */
export interface StoredSignIn {
  version: 1;
  /** The one-time login code; absent: on. */
  local?: { enabled: boolean };
  /** No sign-in: the role everyone gets; absent: off. */
  none?: { role: UiRole };
  /** The first person to sign in with GitHub, admin from then on (issue #239); absent: nobody yet. */
  githubAdmin?: { realm: string; subject: string };
  /** The super admins (issue #242), each an identity by realm and subject; absent: the first GitHub admin, else nobody. */
  superAdmins?: { realm: string; subject: string }[];
  /** How long a UI session lasts (issue #439); absent: the defaults. */
  sessions?: SessionLengths;
  /** In order: the order the form tries them and the buttons show them. */
  realms: StoredRealm[];
}

/**
 * The sign-in config: the config record `sign-in`, read and replaced against `version` — the sha-256
 * of what `read` answers.
 */
/** A vault's table as the system scope uses it (issue #658): the instance's has no templates and no data key. */
export type InstanceVault = Pick<VaultRepository, 'list' | 'get' | 'add' | 'replace' | 'sealed' | 'remove'>;

export interface SignInConfigRepository {
  read(): StoredSignIn;
  version(): string;
  /** Replace them all if still at `version`; false (nothing written) when they moved. */
  write(next: StoredSignIn, version: string): boolean;
}

/** One user's store: the tables of their user schema. Repositories share one connection. */
/**
 * A user's connected account (issue #214): what the provider granted the hopper's app when the user
 * approved its device code — signing in with GitHub, or connecting it from Sources. The token is the hopper's own credential, given to it by that grant
 * — not one the runtime holds — so it is kept here, in the user's schema, and never leaves the daemon.
 */
export interface ConnectedAccount {
  provider: ConnectedAccountProvider;
  /** The account's GitHub login. */
  account: string;
  /** GitHub's stable numeric id for the account: what a GitHub sign-in knows it by. */
  subject: string;
  accessToken: string;
  /** When the access token expires; absent: it does not (a GitHub App that opts out of token expiration). */
  expiresAt?: string;
  /** What renews the access token (issue #358), and when it expires itself; absent: nothing renews it (a record kept before #358, or a token that does not expire). */
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
  /** Why the sign-in ended — GitHub refused the token and its renewal (issue #358): the account is expired, until connected again. */
  ended?: string;
  connectedAt: string;
  /**
   * How GitHub granted it (issue #441): a browser (web flow) grant renews only with the app's client secret, a device flow grant
   * without; absent: kept before #441. `token`: a personal access token the person gave (issue #1380): no app granted it, nothing
   * renews it, and the hopper never deletes it at GitHub.
   */
  grantedBy?: 'device' | 'web' | 'token';
  /** How the person made the connection (issue #647): connected from Sources, or signed in with GitHub; absent: kept before #647. */
  connectedBy?: 'sources' | 'sign-in';
  /**
   * `renewedAt`: when its token was last renewed (issue #647); absent: not renewed since it was connected.
   * `matchEmail`: the email, lowercase, the account was connected for (issue #1380, the source email match): one of its verified emails
   * equalled the email its person signed in with, and each renewal checks it again. Absent: not checked (the setting off, a
   * sign-in that gave no email, a GitHub sign-in, or kept before #1380).
   */
  renewedAt?: string; matchEmail?: string;
}

/** A connected account's row (issue #658): who and when. Its tokens are system secrets in the user's vault (src/connected-accounts/at-rest.ts). */
export type StoredAccount = Omit<ConnectedAccount, 'accessToken' | 'refreshToken'>;

export interface ConnectedAccountRepository {
  /** The account's row, without its tokens, by its key (issue #1448: the first account's is its provider). */
  get(key: ConnectedAccountKey): StoredAccount | undefined;
  /**
   * Insert or replace the account's row, by `key` (absent: its provider, the first account); tokens given with it are not kept
   * here. `keys`: the keys of the rows kept (issue #1448), in key order.
   */
  put(account: StoredAccount, key?: ConnectedAccountKey): void; keys(): ConnectedAccountKey[];
  /** Inside a transaction: lock the account's row until it ends (issue #441); false when there is none. */
  lockRow(key: ConnectedAccountKey): boolean;
  /** The tokens a row kept before issue #658 (sealed by the token box, or in clear), for the move into the vault; none: none left. */
  legacyTokens(key: ConnectedAccountKey): { accessToken: string; refreshToken?: string } | undefined;
  /** The row without the tokens it kept before issue #658: once they are in the vault. */
  dropLegacyTokens(key: ConnectedAccountKey): void;
  /**
   * Take the account's renewal lock, held by this connection until `unlock` or until the connection
   * ends — a crashed process lets it go (issue #441). False when another connection holds it.
   */
  lock(key: ConnectedAccountKey): boolean;
  unlock(key: ConnectedAccountKey): void;
  /** True when there was one. */
  delete(key: ConnectedAccountKey): boolean;
}

export interface UserStore {
  /** The jobs; the job leases (issue #1662): the hopper that drives each claimed or running job. */
  jobs: JobRepository; jobLeases: import('./job-leases.ts').JobLeaseRepository;
  lanes: LaneRepository;
  decisions: DecisionRepository;
  events: EventLog; eventCursors: import('./event-cursors.ts').EventCursorRepository; // event cursors (issue #1572)
  webhooks: WebhookRepository;
  /** The vault (issue #558). */
  vault: VaultRepository;
  /** The job stream; and the machine credential acceptances (issue #1459). */
  jobStream: JobStreamRepository; credentialAcceptances: import('./machine-credentials.ts').CredentialAcceptanceRepository;
  /** The artifacts jobs make for a person to see, and their shares (issue #624). */
  artifacts: ArtifactRepository;
  /** The infra plans jobs record, and their approvals (issue #870). */
  infraPlans: import('./infra-plans.ts').InfraPlanRepository;
  /** The out-of-band infrastructure changes jobs' checks report, their marks, and the controller identities (issue #871). */
  outOfBand: import('./out-of-band.ts').OutOfBandRepository; topology: import('./topology.ts').TopologyRepository; skillLibrary: import('./skill-library.ts').SkillLibraryRepository; // the topology sources (issue #1781), the skill library (issue #1911)
  questions: QuestionRepository;
  /** Each review section's items, by kind: proposals (issue #537), research reports (issue #543). */
  reviews: Readonly<Record<ReviewKind, ReviewItemRepository>>;
  logins: LoginRepository; lastAccounts: import('./logins.ts').LastAccountRepository; // the last accounts (issue #1269)
  failures: FailureRepository;
  problems: ProblemRepository;
  handoffs: HandoffRepository; waitCheckLeases: import('./wait-checks.ts').WaitCheckLeases; // the wait checks' leases (issue #1694)
  itemSnapshots: ItemSnapshotRepository;
  vaultGrants: VaultGrantRepository;
  bugReports: BugReportRepository;
  /** The issue graph (issue #437): store only, nothing reads it yet. */
  issueGraph: import('./issue-graph.ts').IssueGraphRepository; workItems: import('./work-items.ts').WorkItemLedger; // the work-item ledger (issue #1067)
  /** Pointed jobs (issue #425); direct jobs (issue #901): what a person submitted straight to the hopper. */
  pointedJobs: PointedJobRepository; directJobs: import('./direct-jobs.ts').DirectJobRepository; promotions: import('./promotions.ts').PromotionRepository;
  /** GitHub watches (issue #427): each pointed job's last snapshot; the listing cache (issue #985): each repository's latest repository listing; the GitHub outbox (issue #1238): the GitHub changes people's actions asked for, until sent; the repositories' checks as last read (issue #1250), with their answers' ETags; each intake item's arrival (issue #2228). */
  githubWatches: GitHubWatchRepository; githubListings: import('./github-listing.ts').GitHubListingRepository; githubOutbox: import('./github-outbox.ts').GitHubOutboxRepository; repoChecks: import('./repo-checks.ts').RepoChecksReadRepository; intakeArrivals: import('./intake.ts').IntakeArrivalRepository; sourceCalls: import('./sources.ts').SourceCallLog; // the call log (issue #1264)
  /** Each job's latest checkpoint (issue #921): its patch and agent session, scrubbed; pending index updates (issue #945): the documents search writes again once Solr takes them. */
  checkpoints: CheckpointRepository; searchPending: import('./search.ts').SearchPendingRepository; outboundSends: import('./outbound.ts').OutboundSendRepository; notifierDeliveries: import('./notifier-deliveries.ts').NotifierDeliveryRepository; // the send log (issue #1014); notifier deliveries (issue #1587)
  settings: UserSettingsRepository;
  /** Where the hopper's app is installed, as last read for the connected account (issue #1250), with its answers' ETags. */
  connectedAccounts: ConnectedAccountRepository; appInstallations: import('./connected-accounts.ts').AppInstallationsReadRepository;
  /** The token ledger (issue #2302): each model's token use in each agent session of each job; the resource ledger (issue #2504): what the hopper made for each job on a machine. */
  usageHistory: UsageHistoryRepository; tokenLedger: import('./token-usage.ts').TokenLedgerRepository; resourceLedger: import('./resource-ledger.ts').ResourceLedgerRepository;
  machineHistory: MachineHistoryRepository; diskMeasures: import('./hopper-disk.ts').DiskMeasureRepository; deliveryLedger: import('./forecast-accuracy.ts').DeliveryLedgerRepository; stepSchedules: import('./step-schedules.ts').StepScheduleRepository; keptTracks: import('./kept-tracks.ts').KeptTrackRepository; memoryEntries: import('./repo-memory.ts').MemoryEntryRepository; grades: import('./grades.ts').GradeRepository; workPlans: import('./work-plans.ts').WorkPlanRepository; completionReviews: import('./completion-review.ts').CompletionReviewRepository; reviewRecommendations: import('./review-defects.ts').RecommendationRepository; // each machine's last disk measure (issue #2494); each step of each change, predicted and actual (issue #2554 part 6); the step schedules and their runs (issue #2716); each job's kept delivery track and deployment record (issue #2775); the memory entries (issue #2847); each ended job's grades (issue #2845); its completion review and the bug-report recommendations (issue #2846); the plan store (issue #2861)
  /** `plugins`, `rules` and `job-rules`. */
  config: ConfigRecords<UserConfigName>;
  /** Run fn in one transaction. Re-entrant: a nested tx joins the outer one. Throw = rollback. */
  tx<T>(fn: () => T): T;
  /** `reads`: the reads the HTTP read routes make off the event loop (issue #2392), through the read pool, never in `tx`. */
  close(): void; reads: import('./store-reads.ts').UserReads;
}

/** The instance store: the instance schema (design.md "Users: one hopper, separate users"). */
/** What every user's schema keeps sealed under the master key (issue #659): the sealed values' key ids, and the sealed tokens. */
export interface KeptSecrets {
  keyIds: readonly string[];
  tokens: readonly string[];
}

/** What a master key rotation sealed again, and how many values an old key sealed that do not open (left as they were). */
export interface MasterKeyResealed {
  resealed: number;
  unreadable: number;
}

export interface InstanceStore {
  users: UserRepository;
  /** The identity links; the local accounts (issue #1380): the hopper's own email and password sign-in. */
  identities: IdentityLinks; localAccounts: import('./local-accounts.ts').LocalAccountRepository;
  /** The local accounts' passkeys (issue #1380). */
  localAccountPasskeys: import('./local-accounts.ts').LocalAccountPasskeyRepository;
  /** The UI sessions and API tokens; the grants and their refresh tokens (issue #881). */
  uiSessions: UiSessionRepository; apiGrants: import('./api-grants.ts').ApiGrantRepository;
  loginCodes: LoginCodeRepository;
  joinCodes: JoinCodeRepository; lanePoolKeys: import('./lane-pool-keys.ts').LanePoolKeyRepository; // the lane pool keys the hopper issued (issue #1454)
  /** The sandbox records (issue #708). */
  sandboxes: SandboxRepository; sandboxRuns: import('./sandbox-runs.ts').SandboxRunRepository; needSteps: import('./need-steps.ts').NeedStepRepository; windowsSteps: import('./windows-steps.ts').WindowsStepRepository; sagas: import('./sagas.ts').SagaRepository; sweepLeases: import('./leases.ts').SweepLeaseRepository; outboundKeys: import('./outbound.ts').OutboundKeyRepository; // the sandbox runs: each sandbox made for one step (issue #1349); the sandbox steps: each need or box step from the job's ask to its result (issue #1568); the Windows steps, likewise, with each host's hold (issue #1611); the sagas: work across a boundary, kept step by step, that goes on after a stop on any host (issue #1524); the sweep leases and the outbound dedupe keys: what makes two hosts on one database run each sweep and send each send once (issue #1627)
  /** `sign-in`, without the password accounts (the CLI's `hopper config … sign-in`). */
  config: ConfigRecords<InstanceConfigName>;
  /** The sign-in config: the `sign-in` record with the password accounts. */
  signInConfig: SignInConfigRepository;
  settings: InstanceSettingsRepository;
  /** Access (issue #559): the models, the approvals pushed to OpenFGA, the mint decisions. */
  access: AccessRepository;
  /** The instance's vault (issue #658): the system secrets of the whole hopper — its sign-in realms' secrets. The hopper's
   * Postgres as Postgres itself says (issue #947): connections, size, cache, locks, transactions, statements; the stack samples. */
  vault: InstanceVault; databaseStats: import('./stack-resources.ts').DatabaseStats; stackHistory: import('./stack-resources.ts').StackHistoryRepository;
  /** Open the user's store: one more connection, its schema migrated on the tenant track. The caller closes it. */
  userStore(user: User): UserStore;
  /** What the users' schemas keep sealed under the master key (issue #659); a vault a KMS data key seals is left out. */
  keptSecrets(): KeptSecrets;
  /**
   * The master key rotation (issue #659): in one transaction, every value `from` sealed, in every schema, sealed again
   * under `to`, its new fingerprint recorded, and the rotation. A value no `from` key sealed is left; one that does not
   * open is counted, and left. Throws, and changes nothing, when a write fails.
   */
  rotateMasterKey(o: { from: { key: string; previous: readonly string[] }; to: string }): MasterKeyResealed;
  /**
   * The daemon lock, for this store's life: `holdDaemonLock` shared, as each daemon on the database holds it (issue #1662),
   * false while an operator command holds it alone; `holdSoleLock` alone, false while a daemon or another command holds it.
   */
  holdDaemonLock(): boolean; holdSoleLock(): boolean;
  tx<T>(fn: () => T): T;
  close(): void;
}
