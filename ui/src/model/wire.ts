// The HTTP API's shapes as the UI reads them. Domain types come from src/domain/types.ts as
// type-only imports: the wire contract has one definition, and nothing of src/ is bundled.
import type {
  AttachedMachine, Decision, DomainEvent, InstanceSpec, Job, JobStatus, Lane, MachineEdit, MachineLaneEffect, MachineSnapshot, MachinesConfig, PartAccount, PluginsEdit, PluginsReport,
  Question, QuestionAttempt, QuestionGatesView, QuestionStatus, RiskRuleView, Role, RoutingReport, RulesFileView, SelectableRole, ListRole, SourceStatus, UsageReading, UsageReport, UsageSourceReport, WebhookDelivery,
  WebhookSubscription, WebhooksEdit,
} from '../../../src/domain/types.ts';

export type {
  AttachedMachine, Decision, DomainEvent, InstanceSpec, Job, JobStatus, Lane, MachineEdit, MachineLaneEffect, MachinesConfig, PartAccount, PluginsEdit, PluginsReport,
  Question, QuestionAttempt, QuestionGatesView, QuestionStatus, RiskRuleView, Role, RoutingReport, RulesFileView, SelectableRole, ListRole, SourceStatus, UsageReading, UsageReport, UsageSourceReport, WebhookDelivery,
  WebhookSubscription, WebhooksEdit,
};

export interface Queue {
  waiting: Job[];
  running: Job[];
  waitingAnswer: Job[];
  /** Jobs ended in the last 24 hours, newest end first. */
  ended: Job[];
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
/** A subscription as GET /api/webhooks shows it: no secret, only where it lives. */
export type WebhookView = Omit<WebhookSubscription, 'secret'> & { secretSource: 'inline' | 'file' };

export interface WebhooksView {
  subscriptions: WebhookView[];
  config?: WebhookConfig;
  secret?: string;
}
