// The HTTP API's shapes as the UI reads them. Domain types come from src/domain/types.ts as
// type-only imports: the wire contract has one definition, and nothing of src/ is bundled.
import type {
  AttachedMachine, Decision, DomainEvent, HostKeyOffer, InstanceSpec, Job, JobStatus, Lane, MachineDefaultsEdit, MachineEdit, MachineLaneEffect, MachineSnapshot, MachinesConfig, OptionChoice, PartAccount, PluginsEdit, PluginsReport,
  Question, QuestionAttempt, QuestionGatesView, RaisedBy, JobRulesView, QuestionStatus, RiskRuleView, Role, RoutingReport, RulesView, SelectableRole, ListRole, SourceStatus, UsageReading, UsageReport, UsageSourceReport, WebhookDelivery,
  WebhookSubscription, WebhooksEdit, SessionLengths, SessionUser, SessionView, SignInRealmView, UiRole, UpdateStatus, UpdateChannel, VersionHistory, PluginStoreEdit, PluginStoreEntry, PluginStoreReport, ConnectedAccountStatus, AppInstallation,
  InstanceTotals, UsageTotal, UserAdded, UserView, RealmSettings, RealmType, RealmView, RealmsEdit, RealmsView, PersonView, PreSort, QueueGate, QueueGateMode,
  InstanceUsageHistory, UsageGraphView, UsageHistory, UsageLimitPair, UsageLimits, UsageSeries, UsageTotalSeries, NotifierAction, NotifierActionResult,
  MachineHistory, MachineResource, ResourceReading, ResourceSeries,
  Login, LoginSettings, LoginStatus, LoginView,
  Allowed, FailureDecision, FailureRecordView, FailureSettings, FailuresView, HandoffReason, HandoffResolution, HandoffResolutionAction, HandoffView, JobAssessment, KnownCause, ProblemView, SignatureStat,
  LaneReliability, PriorityLaneIdle, PriorityLaneSettings, PriorityLaneView, PriorityLanesView, QuestionView,
  ReviewDecision, ReviewEntry, ReviewItem, ReviewItemView, ReviewKind, ReviewSectionView, ReviewSettings, ReviewSettingsView, ReviewSignOffBy, ReviewStatus, ReviewVersion,
  SectionKind, SectionSummary,
  ActorMachine, BlastRadiusSettings, BlastRadiusView, DiscoveryChanges, DiscoveryRecord, GateAt, MachineRadiusView, RadiusLevel, Reach, UnconfirmedAs, TemplateRadius, TemplateProfileRadius,
  DecisionPoint, DecisionPointView, MinorDecisionMode, MinorDecisionOption, MinorDecisionPickView, MinorDecisionsView,
  ForkParent, ForkQuestion, JobPhase, PhaseShiftSettings, PhaseShiftSettingsView, PhaseSuggestion, QuestionFork, QuestionShifts, ShiftMode, ShiftThen,
  CredentialRequest, Template, TemplateView, VaultBackendView, VaultSecret, VaultView, YoloModeSettings, YoloModeView,
  AccessDecisionRecord, AccessModelView, AccessState, AccessStatus, AccessView, Approval, Operation, OperationProfile, RelationshipTuple, RevokedApproval, Asset, AssetKind, Requester, RequesterRow,
} from '../../../src/domain/types.ts';

export type {
  AttachedMachine, Decision, DomainEvent, HostKeyOffer, InstanceSpec, Job, JobStatus, Lane, MachineDefaultsEdit, MachineEdit, MachineLaneEffect, MachinesConfig, OptionChoice, PartAccount, PluginsEdit, PluginsReport,
  Question, QuestionAttempt, QuestionGatesView, RaisedBy, JobRulesView, QuestionStatus, RiskRuleView, Role, RoutingReport, RulesView, SelectableRole, ListRole, SourceStatus, UsageReading, UsageReport, UsageSourceReport, WebhookDelivery,
  WebhookSubscription, WebhooksEdit, SessionLengths, SessionUser, SessionView, SignInRealmView, UiRole, UpdateStatus, UpdateChannel, VersionHistory, PluginStoreEdit, PluginStoreEntry, PluginStoreReport, ConnectedAccountStatus, AppInstallation,
  InstanceTotals, UsageTotal, UserAdded, UserView, RealmSettings, RealmType, RealmView, RealmsEdit, RealmsView, PersonView, PreSort, QueueGate, QueueGateMode,
  InstanceUsageHistory, UsageGraphView, UsageHistory, UsageLimitPair, UsageLimits, UsageSeries, UsageTotalSeries, NotifierAction, NotifierActionResult,
  MachineHistory, MachineResource, ResourceReading, ResourceSeries,
  Login, LoginSettings, LoginStatus, LoginView,
  Allowed, FailureDecision, FailureRecordView, FailureSettings, FailuresView, HandoffReason, HandoffResolution, HandoffResolutionAction, HandoffView, JobAssessment, KnownCause, ProblemView, SignatureStat,
  LaneReliability, PriorityLaneIdle, PriorityLaneSettings, PriorityLaneView, PriorityLanesView, QuestionView,
  ReviewDecision, ReviewEntry, ReviewItem, ReviewItemView, ReviewKind, ReviewSectionView, ReviewSettings, ReviewSettingsView, ReviewSignOffBy, ReviewStatus, ReviewVersion,
  SectionKind, SectionSummary,
  ActorMachine, BlastRadiusSettings, BlastRadiusView, DiscoveryChanges, DiscoveryRecord, GateAt, MachineRadiusView, RadiusLevel, Reach, UnconfirmedAs, TemplateRadius, TemplateProfileRadius,
  DecisionPoint, DecisionPointView, MinorDecisionMode, MinorDecisionOption, MinorDecisionPickView, MinorDecisionsView,
  ForkParent, ForkQuestion, JobPhase, PhaseShiftSettings, PhaseShiftSettingsView, PhaseSuggestion, QuestionFork, QuestionShifts, ShiftMode, ShiftThen,
  CredentialRequest, Template, TemplateView, VaultBackendView, VaultSecret, VaultView, YoloModeSettings, YoloModeView,
  AccessDecisionRecord, AccessModelView, AccessState, AccessStatus, AccessView, Approval, Operation, OperationProfile, RelationshipTuple, RevokedApproval, Asset, AssetKind, Requester, RequesterRow,
};

export interface Queue {
  waiting: Job[];
  running: Job[];
  waitingAnswer: Job[];
  /** Jobs claimed as operator-led (issue #318). */
  operatorLed: Job[];
  /** Parked jobs (issue #501): on no lane, until picked up. */
  parked: Job[];
  /** The locked entries (issue #355): failed jobs kept in the queue until run again or dismissed, highest priority first. */
  locked: Job[];
  /** Jobs ended in the last 24 hours, newest end first. */
  ended: Job[];
  /** The queue gate (issue #159). */
  gate: QueueGate;
  /** The pre-sort of the waiting jobs not yet accepted. */
  presort: PreSort;
  /** The high-priority threshold (issue #535): a job at or above it is tagged and listed first. */
  highPriority: number;
}

/** GET /api/logins (issue #476): the server's time for the countdowns, the logins settings, the logins newest first. */
export interface LoginsRead {
  now: string;
  settings: LoginSettings;
  logins: LoginView[];
}

export type MachineView = MachineSnapshot & { lanes: Lane[]; usage: UsageReading[] };

export interface Health {
  ok: boolean;
  version: string;
  router: string;
  fallback: boolean;
  executors: string[];
  /** The executors that can park a job (issue #530): Park is offered only for their jobs. */
  parkingExecutors?: string[];
  /** The executors that write research reports and proposals (issue #548): only their jobs shift phase from a question. */
  reviewingExecutors?: string[];
  uptimeS: number;
}

/** A subscription as GET /api/webhooks shows it: when its secret changed (or the variable one from before reads), and why it cannot sign (if so). Never a secret. */
export type WebhookView = WebhookSubscription & { secretProblem?: string };

/** GET /api/webhooks, and the answer to POST /ui/api/webhooks. */
export interface WebhooksView {
  subscriptions: WebhookView[];
  /** Only in the answer to the edit that made it (add with no secret typed in, rotate; issue #451): shown once. */
  generatedSecret?: string;
}
