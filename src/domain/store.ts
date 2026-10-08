// The store's ports (design.md "Database", "Users: one hopper, separate users"): the repositories, a
// user's store and the instance store. Re-exported from ports.ts.

import type {
  DomainEvent, Decision, EventType, Job, JobId, JobSpec, JobStatus, Lane, JobSourceRef, LaneId, MachineId, NewEvent, Question, QuestionAttempt, QuestionStatus,
  Identity, QueueGate, SessionLengths, UiRole, WebhookDelivery, WebhookSubscription, UpdateSettings, PluginInstall, PluginStoreSource, User,
  UsageGraphView, UsageSample, UsageSeries, UsageTotalSeries,
} from './types.ts';
import type { ConnectedAccountProvider } from './types.ts';

// ---- Persistence -----------------------------------------------------------------------

export interface JobFilter {
  status?: JobStatus[];
  limit?: number;
}

export interface JobRepository {
  create(spec: JobSpec, priority: number, source?: JobSourceRef): Job;
  get(id: JobId): Job | undefined;
  getBySourceKey(key: string): Job | undefined;
  list(filter?: JobFilter): Job[];
  /** Shallow-merge patch; a key present with value `undefined` clears that field. Bumps updatedAt. */
  update(id: JobId, patch: Partial<Omit<Job, 'id' | 'spec' | 'createdAt'>>): Job;
  /** Replace the spec of a job that has not started (issue #375). Bumps updatedAt. */
  respecify(id: JobId, spec: JobSpec): Job;
}

export interface LaneRepository {
  list(machineId?: MachineId): Lane[];
  /** Opens the lowest free lane number for the machine. */
  open(machineId: MachineId): Lane;
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
  /** Newest first. */
  recent(limit?: number, types?: EventType[]): DomainEvent[];
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
  add(input: { name: string; url: string; events: string[]; secretEnv: string; active: boolean }): WebhookSubscription | undefined;
  /** Changes only the fields given; undefined when there is no such subscription. */
  update(id: string, patch: { url?: string; events?: string[]; active?: boolean }): WebhookSubscription | undefined;
  get(id: string): WebhookSubscription | undefined;
  list(): WebhookSubscription[];
  /** Deletes the subscription and marks its pending/retrying deliveries `failed`. */
  delete(id: string): boolean;
  /** status `pending`, attempts 0, nextAttemptAt = now. */
  createDelivery(subscriptionId: string, event: DomainEvent): WebhookDelivery;
  updateDelivery(id: string, patch: Partial<Omit<WebhookDelivery, 'id' | 'subscriptionId' | 'eventSeq' | 'eventType' | 'createdAt'>>): WebhookDelivery;
  /** Deliveries due at or before `now`: status pending|retrying and nextAttemptAt <= now. */
  dueDeliveries(now: Date): WebhookDelivery[];
  listDeliveries(filter?: { subscriptionId?: string; limit?: number }): WebhookDelivery[];
}

export interface QuestionRepository {
  /** `tier`: the stage it starts at (the first escalation level's instance name, or `human`). */
  create(input: { jobId: JobId; text: string; recentOutput: string; detectedBy: string; tier: string; lapsesAt?: string }): Question;
  get(id: string): Question | undefined;
  /** Newest first. */
  /** By creation: `newest-first` (the default; a history) or `oldest-first` (the open questions, the longest waiting first; issue #450). A limit keeps the first of that order. */
  list(filter?: { status?: QuestionStatus[]; jobId?: JobId; limit?: number; order?: 'oldest-first' | 'newest-first' }): Question[];
  /** Shallow-merge; `undefined` clears. Bumps updatedAt. */
  update(id: string, patch: Partial<Omit<Question, 'id' | 'jobId' | 'createdAt' | 'attempts'>>): Question;
  /** Append one attempt to the question's trail. */
  addAttempt(id: string, attempt: QuestionAttempt): Question;
}

/** A user's settings (in the user schema). */
export interface UserSettingsRepository {
  /** The user's queue gate (issue #159); absent: never set. */
  getQueueGate(): QueueGate | undefined;
  setQueueGate(gate: QueueGate): void;
  /** The hopper's own ssh key for this user's machines (issue #293): a secret, never answered by any route but its public half. */
  getSshKey(): { privateKey: string; publicKey: string } | undefined;
  setSshKey(key: { privateKey: string; publicKey: string }): void;
  /** The hopper's link key for this user's machines that dial in (issue #308): a secret, never answered by any route but its public half. */
  getLinkKey(): { privateKey: string; publicKey: string } | undefined;
  setLinkKey(key: { privateKey: string; publicKey: string }): void;
  /** The repositories a connected account's jobs may use (issue #321); empty: none chosen. */
  getJobRepositories(provider: ConnectedAccountProvider): string[];
  setJobRepositories(provider: ConnectedAccountProvider, repositories: readonly string[]): void;
  /** The usage graph's range and step the user chose (issue #385); absent: never chosen. */
  getUsageGraphView(): UsageGraphView | undefined;
  setUsageGraphView(view: UsageGraphView): void;
  /** How many days usage samples are kept (issue #385); absent: never chosen. */
  getHistoryRetentionDays(): number | undefined;
  setHistoryRetentionDays(days: number): void;
}

/** What the usage graph reads: a stretch, its graph step, and the time steps are counted from (a local midnight, a Monday). */
export interface UsageHistoryQuery {
  from: Date;
  to: Date;
  stepMs: number;
  originMs: number;
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

/** The instance's settings (in the instance schema): self-update, the plugin store and its store installs. */
export interface InstanceSettingsRepository {
  /** Self-update settings an admin chose; absent fields were never set. */
  getUpdateSettings(): Partial<UpdateSettings>;
  setUpdateSettings(patch: Partial<UpdateSettings>): void;
  /** The store installs, by id (issue #93). */
  getPluginInstalls(): PluginInstall[];
  setPluginInstalls(installs: readonly PluginInstall[]): void;
  /** The plugin store setting (issue #445); undefined: never set. */
  getPluginStoreSource(): PluginStoreSource | undefined;
  setPluginStoreSource(source: PluginStoreSource): void;
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
}

/** UI sessions, keyed by the SHA-256 of the token; the token itself is never stored. Which have ended is the caller's to decide. */
export interface UiSessionRepository {
  create(row: UiSessionRow): void;
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
export interface JoinCodeRepository {
  create(codeHash: string, expiresAt: string, userId: string): void;
  /** The code's user, and the code is gone, when it exists and `expiresAt > now`; else undefined. Expired codes are deleted first. */
  take(codeHash: string, now: string): string | undefined;
}

/**
 * The config records the store holds (design.md "Config in the database", issue #198): a user's
 * `plugins`, `rules` and `job-rules`, and the instance's `sign-in`. No config lives in a file.
 */
export const USER_CONFIG = ['plugins', 'rules', 'job-rules'] as const;
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
  /** A new user under a unique name (throws when taken): its row and its user schema. */
  add(name: string): User;
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
}

export interface ConnectedAccountRepository {
  get(provider: ConnectedAccountProvider): ConnectedAccount | undefined;
  /** Insert or replace the provider's account. */
  put(account: ConnectedAccount): void;
  /** True when there was one. */
  delete(provider: ConnectedAccountProvider): boolean;
}

export interface UserStore {
  jobs: JobRepository;
  lanes: LaneRepository;
  decisions: DecisionRepository;
  events: EventLog;
  webhooks: WebhookRepository;
  questions: QuestionRepository;
  settings: UserSettingsRepository;
  connectedAccounts: ConnectedAccountRepository;
  usageHistory: UsageHistoryRepository;
  /** `plugins`, `rules` and `job-rules`. */
  config: ConfigRecords<UserConfigName>;
  /** Run fn in one transaction. Re-entrant: a nested tx joins the outer one. Throw = rollback. */
  tx<T>(fn: () => T): T;
  close(): void;
}

/** The instance store: the instance schema (design.md "Users: one hopper, separate users"). */
export interface InstanceStore {
  users: UserRepository;
  identities: IdentityLinks;
  uiSessions: UiSessionRepository;
  loginCodes: LoginCodeRepository;
  joinCodes: JoinCodeRepository;
  /** `sign-in`, without the password accounts (the CLI's `hopper config … sign-in`). */
  config: ConfigRecords<InstanceConfigName>;
  /** The sign-in config: the `sign-in` record with the password accounts. */
  signInConfig: SignInConfigRepository;
  settings: InstanceSettingsRepository;
  /** Open the user's store: one more connection, its schema migrated on the tenant track. The caller closes it. */
  userStore(user: User): UserStore;
  /** Take the daemon lock on this database for this store's life: false when another process holds it (a running daemon). */
  holdDaemonLock(): boolean;
  tx<T>(fn: () => T): T;
  close(): void;
}
