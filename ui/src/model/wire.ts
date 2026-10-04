// The HTTP API's shapes as the UI reads them. Domain types come from src/domain/types.ts as
// type-only imports: the wire contract has one definition, and nothing of src/ is bundled.
import type {
  Decision, DomainEvent, InstanceSpec, Job, JobStatus, Lane, MachineLaneEffect, MachineSnapshot, PartAccount, PluginsEdit, PluginsReport, Question, QuestionAttempt,
  QuestionGatesView, RiskRuleView, Role, RulesFileView, SelectableRole, SourceStatus, UsageReading, UsageReport, UsageSourceReport, WebhookDelivery, WebhookSubscription, WebhooksEdit,
} from '../../../src/domain/types.ts';

export type {
  Decision, DomainEvent, InstanceSpec, Job, JobStatus, Lane, MachineLaneEffect, PartAccount, PluginsEdit, PluginsReport, Question, QuestionAttempt,
  QuestionGatesView, RiskRuleView, Role, RulesFileView, SelectableRole, SourceStatus, UsageReading, UsageReport, UsageSourceReport, WebhookDelivery, WebhookSubscription, WebhooksEdit,
};

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
  /** webhooks.yaml's sha-256, or `missing`: what a POST /ui/api/webhooks edit is made against. */
  version?: string;
}

/** GET /api/webhooks (secrets omitted); the answer to POST /ui/api/webhooks adds `secret` after add or rotate-secret. */
export interface WebhooksView {
  subscriptions: WebhookSubscription[];
  config?: WebhookConfig;
  secret?: string;
}
