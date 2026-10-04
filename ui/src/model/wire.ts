// The HTTP API's shapes as the UI reads them. Domain types come from src/domain/types.ts as
// type-only imports: the wire contract has one definition, and nothing of src/ is bundled.
import type { Decision, DomainEvent, Job, JobStatus, Lane, MachineSnapshot, Question, SourceStatus, UsageReading, WebhookDelivery, WebhookSubscription } from '../../../src/domain/types.ts';

export type { Decision, DomainEvent, Job, JobStatus, Lane, Question, SourceStatus, UsageReading, WebhookDelivery, WebhookSubscription };

export interface Queue {
  waiting: Job[];
  running: Job[];
  waitingAnswer: Job[];
  /** Ended jobs, newest end first, at most 20. */
  ended: Job[];
  counts: Partial<Record<JobStatus, number>>;
}

export type MachineView = MachineSnapshot & { lanes: Lane[]; usage: UsageReading[] };

export interface Health {
  ok: boolean;
  version: string;
  routerMode: 'shadow' | 'active';
  router: string;
  fallback: boolean;
  executors: string[];
  uptimeS: number;
}

export interface WebhookConfig {
  path?: string;
  loadedAt?: string;
  error?: string;
  warnings?: string[];
}
