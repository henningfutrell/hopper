// The store's ports (design.md "Database", "Users: one hopper, separate users"): the repositories, a
// user's store and the instance store. Re-exported from ports.ts.

import type {
  DomainEvent, Decision, EventType, Job, JobId, JobSpec, JobStatus, Lane, JobSourceRef, LaneId, MachineId, NewEvent, Question, QuestionAttempt, QuestionStatus,
  Identity, QueueGate, RouterMode, UiRole, WebhookDelivery, WebhookSubscription, UpdateSettings, PluginInstall, User,
} from './types.ts';

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
  create(input: { jobId: JobId; text: string; recentOutput: string; detectedBy: string; tier: string }): Question;
  get(id: string): Question | undefined;
  /** Newest first. */
  list(filter?: { status?: QuestionStatus[]; jobId?: JobId; limit?: number }): Question[];
  /** Shallow-merge; `undefined` clears. Bumps updatedAt. */
  update(id: string, patch: Partial<Omit<Question, 'id' | 'jobId' | 'createdAt' | 'attempts'>>): Question;
  /** Append one attempt to the question's trail. */
  addAttempt(id: string, attempt: QuestionAttempt): Question;
}

/** A user's settings (in the user schema). */
export interface UserSettingsRepository {
  getRouterMode(): RouterMode | undefined;
  setRouterMode(mode: RouterMode): void;
  /** The user's queue gate (issue #159); absent: never set. */
  getQueueGate(): QueueGate | undefined;
  setQueueGate(gate: QueueGate): void;
}

/** The instance's settings (in the instance schema): self-update and the store installs. */
export interface InstanceSettingsRepository {
  /** Self-update settings an admin chose; absent fields were never set. */
  getUpdateSettings(): Partial<UpdateSettings>;
  setUpdateSettings(patch: Partial<UpdateSettings>): void;
  /** The store installs, by id (issue #93). */
  getPluginInstalls(): PluginInstall[];
  setPluginInstalls(installs: readonly PluginInstall[]): void;
}

/** A stored UI session: never the token, only its SHA-256; the user it acts for (issue #158). */
export interface UiSessionRow { tokenHash: string; expiresAt: string; role: UiRole; identity: Identity; userId: string }

/** UI sessions, keyed by the SHA-256 of the token; the token itself is never stored. */
export interface UiSessionRepository {
  create(row: UiSessionRow): void;
  /** The live session with this hash, or undefined. Expired rows (`expires_at <= now`) are deleted first. */
  find(tokenHash: string, now: string): UiSessionRow | undefined;
  /** Every stored session, expired or not. */
  all(): UiSessionRow[];
  setRole(tokenHash: string, role: UiRole): void;
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

/**
 * The config records the store holds (design.md "Config in the database", issue #198): a user's
 * `plugins` and `rules`, and the instance's `sign-in`. No config lives in a file.
 */
export const USER_CONFIG = ['plugins', 'rules'] as const;
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
  /** The default admin account, `admin` (issue #220). */
  admin(): User;
  /** A new user under a unique name (throws when taken): its row and its user schema. */
  add(name: string): User;
  /**
   * `to` takes over `from`'s work (issue #212): `to`'s sign-ins, sessions and login codes move onto
   * `from`'s record, which takes `to`'s name; `to`'s record and user schema are removed. Throws, nothing
   * changed, when `to` holds work of its own (jobs, questions, decisions, webhooks). The record kept.
   */
  transfer(fromId: string, toId: string): User;
}

/** Which user an identity signs in as (`user_identities`). */
export interface IdentityLinks {
  userOf(realm: string, subject: string): string | undefined;
  /** Link the identity to the user; an existing link is kept. */
  link(realm: string, subject: string, userId: string): void;
  /** Link the identity to the user, in place of any link it had (a new password account names its user). */
  replace(realm: string, subject: string, userId: string): void;
}

/** A password account as stored (`password_accounts`, issue #200): its argon2id hash, never the password. */
export interface StoredAccount { username: string; passwordHash: string; role: UiRole }

/**
 * One realm as stored: its name, type, label (absent: its name), `enabled: false` when off, and the
 * settings of its type (src/auth/config.ts checks them); a password realm's accounts in `users`.
 */
export type StoredRealm = { name: string; type: string; label?: string; enabled?: boolean; users?: StoredAccount[] } & { [setting: string]: unknown };

/**
 * The sign-in config as stored (design.md "Sign-in: realms", issues #198, #200): the config record
 * `sign-in` with each password realm's accounts from `password_accounts` in its `users` — the value
 * src/auth/config.ts loads.
 */
export interface StoredSignIn {
  version: 1;
  /** The one-time login code; absent: on. */
  local?: { enabled: boolean };
  /** No sign-in: the role everyone gets; absent: off. */
  none?: { role: UiRole };
  /** In order: the order the form tries them and the buttons show them. */
  realms: StoredRealm[];
}

/**
 * The sign-in config: the config record `sign-in` and the `password_accounts` rows, read and replaced
 * together against `version` — the sha-256 of what `read` answers.
 */
export interface SignInConfigRepository {
  read(): StoredSignIn;
  version(): string;
  /** Replace them all if still at `version`; false (nothing written) when they moved. */
  write(next: StoredSignIn, version: string): boolean;
}

/** One user's store: the tables of their user schema. Repositories share one connection. */
export interface UserStore {
  jobs: JobRepository;
  lanes: LaneRepository;
  decisions: DecisionRepository;
  events: EventLog;
  webhooks: WebhookRepository;
  questions: QuestionRepository;
  settings: UserSettingsRepository;
  /** `plugins` and `rules`. */
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
