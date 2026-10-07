// The HTTP API's shapes as the UI reads them. Domain types come from src/domain/types.ts as
// type-only imports: the wire contract has one definition, and nothing of src/ is bundled.
import type {
  AttachedMachine, Decision, DomainEvent, HostKeyOffer, InstanceSpec, Job, JobStatus, Lane, MachineDefaultsEdit, MachineEdit, MachineLaneEffect, MachineSnapshot, MachinesConfig, OptionChoice, PartAccount, PluginsEdit, PluginsReport,
  Question, QuestionAttempt, QuestionGatesView, JobRulesView, QuestionStatus, RiskRuleView, Role, RoutingReport, RulesView, SelectableRole, ListRole, SourceStatus, UsageReading, UsageReport, UsageSourceReport, WebhookDelivery,
  WebhookSubscription, WebhooksEdit, SessionUser, SessionView, SignInRealmView, UiRole, UpdateStatus, UpdateChannel, VersionHistory, PluginStoreEdit, PluginStoreEntry, PluginStoreReport, ConnectedAccountStatus, AppInstallation,
  InstanceTotals, UsageTotal, UserAdded, UserView, RealmSettings, RealmType, RealmView, RealmsEdit, RealmsView, PersonView, PreSort, QueueGate, QueueGateMode,
} from '../../../src/domain/types.ts';

export type {
  AttachedMachine, Decision, DomainEvent, HostKeyOffer, InstanceSpec, Job, JobStatus, Lane, MachineDefaultsEdit, MachineEdit, MachineLaneEffect, MachinesConfig, OptionChoice, PartAccount, PluginsEdit, PluginsReport,
  Question, QuestionAttempt, QuestionGatesView, JobRulesView, QuestionStatus, RiskRuleView, Role, RoutingReport, RulesView, SelectableRole, ListRole, SourceStatus, UsageReading, UsageReport, UsageSourceReport, WebhookDelivery,
  WebhookSubscription, WebhooksEdit, SessionUser, SessionView, SignInRealmView, UiRole, UpdateStatus, UpdateChannel, VersionHistory, PluginStoreEdit, PluginStoreEntry, PluginStoreReport, ConnectedAccountStatus, AppInstallation,
  InstanceTotals, UsageTotal, UserAdded, UserView, RealmSettings, RealmType, RealmView, RealmsEdit, RealmsView, PersonView, PreSort, QueueGate, QueueGateMode,
};

export interface Queue {
  waiting: Job[];
  running: Job[];
  waitingAnswer: Job[];
  /** Jobs ended in the last 24 hours, newest end first. */
  ended: Job[];
  /** The queue gate (issue #159). */
  gate: QueueGate;
  /** The pre-sort of the waiting jobs not yet accepted. */
  presort: PreSort;
}

export type MachineView = MachineSnapshot & { lanes: Lane[]; usage: UsageReading[] };

export interface Health {
  ok: boolean;
  version: string;
  router: string;
  fallback: boolean;
  executors: string[];
  uptimeS: number;
}

/** A subscription as GET /api/webhooks shows it: the variable its secret is in, and why the runtime gives none (if so). Never a secret. */
export type WebhookView = WebhookSubscription & { secretProblem?: string };

/** GET /api/webhooks, and the answer to POST /ui/api/webhooks. */
export interface WebhooksView {
  subscriptions: WebhookView[];
}
