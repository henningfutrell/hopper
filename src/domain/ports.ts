// Seams. Everything the engine talks to that is not pure domain logic sits behind one of
// these. Adapters live in src/{executors,machines,usage,jev,store,webhooks}.

import type {
  DomainEvent, Decision, EventType, Job, JobId, JobSpec, JobStatus, JevAdvice, JevMode, Lane,
  LaneId, MachineId, MachineSnapshot, NewEvent, UsageReading, WebhookDelivery,
  WebhookSubscription,
} from './types.ts';

// ---- Execution -----------------------------------------------------------------------

export interface ExecutionContext {
  job: Job;
  laneId: LaneId;
  /** Aborted on cancel or daemon shutdown. An executor must stop promptly when it fires. */
  signal: AbortSignal;
  /** Report progress 0..1 with an optional message. Emits job.progressed. */
  progress(fraction: number, message?: string): void;
}

export type ExecutionOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

/**
 * Runs one job on one lane. `name` matches JobSpec.executor. The built-in is "test";
 * a future "herdr-claude" executor implements the same contract.
 * Must resolve (never reject) — a thrown error is converted to { ok: false } by the engine,
 * but adapters should report their own failures.
 */
export interface Executor {
  readonly name: string;
  /** Validate a payload at push time; return an error string or null. */
  validate(payload: Record<string, unknown>): string | null;
  run(ctx: ExecutionContext): Promise<ExecutionOutcome>;
}

// ---- Inputs the decider is made over ---------------------------------------------------

/** A pluggable source of machines. The local laptop is one; a remote host would be another. */
export interface MachineSource {
  list(): Promise<MachineSnapshot[]>;
}

/** A pluggable usage-budget source. Returns zero or more readings per poll. */
export interface UsageSource {
  readonly name: string;
  poll(): Promise<UsageReading[]>;
}

/** Jev, as job-hopper consumes it: classify one job, return advice. Never throws. */
export interface JevAdvisor {
  readonly name: string;
  advise(job: Job): Promise<JevAdvice>;
}

export interface Clock {
  now(): Date;
}

export type IdGen = () => string;

export interface ExecutorRegistry {
  get(name: string): Executor | undefined;
  names(): string[];
}

/** A usage source whose readings can be set by hand — the fake, driven by PUT /api/usage/fake. */
export interface SettableUsageSource extends UsageSource {
  /** Replace the reading for (machineId ?? global); returns all current readings. */
  set(reading: Omit<UsageReading, 'source' | 'at'>): UsageReading[];
}

export interface WebhookDispatcher {
  /** Subscribe to the EventLog (create deliveries) and start the due-delivery sweep. */
  start(): void;
  /** Stop the sweep; wait for in-flight requests (bounded by their timeout). */
  stop(): Promise<void>;
  /** Called on every delivery state change. Feeds SSE `delivery.updated`. */
  onDeliveryUpdated(listener: (delivery: WebhookDelivery) => void): () => void;
}

// ---- Persistence -----------------------------------------------------------------------

export interface JobFilter {
  status?: JobStatus[];
  limit?: number;
}

export interface JobRepository {
  create(spec: JobSpec, priority: number): Job;
  get(id: JobId): Job | undefined;
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
  create(input: { url: string; events: string[]; secret: string }): WebhookSubscription;
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

export interface SettingsRepository {
  getJevMode(): JevMode | undefined;
  setJevMode(mode: JevMode): void;
}

/** The whole store. One SQLite file; repositories share one connection. */
export interface Store {
  jobs: JobRepository;
  lanes: LaneRepository;
  decisions: DecisionRepository;
  events: EventLog;
  webhooks: WebhookRepository;
  settings: SettingsRepository;
  /** Run fn in one transaction. Re-entrant: a nested tx joins the outer one. Throw = rollback. */
  tx<T>(fn: () => T): T;
  close(): void;
}
