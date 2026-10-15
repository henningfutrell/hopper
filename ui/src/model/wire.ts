// The HTTP API's shapes as the UI reads them. Domain types come from src/domain/types.ts as
// type-only imports: the wire contract has one definition, and nothing of src/ is bundled.
import type {
  AttachedMachine, Decision, DomainEvent, HostKeyOffer, InstanceSpec, Job, JobStatus, Lane, MachineDefaultsEdit, MachineEdit, MachineLaneEffect, MachineSnapshot, MachinesConfig, SandboxesView, CleanupProblem, OptionChoice, PartAccount, PluginsEdit, PluginsReport,
  WindowsHost, WindowsHostsView,
  Question, QuestionAttempt, QuestionGatesView, RaisedBy, JobRulesView, QuestionStatus, RiskRuleView, Role, RoutingReport, RulesView, SelectableRole, ListRole, SourceStatus, UsageReading, UsageReport, UsageSourceReport, ToolAccount, ToolAccountMachine, ToolAccountsReport, ToolLogin, WebhookDelivery,
  WebhookSubscription, WebhooksEdit, SessionLengths, SessionUser, SessionView, SignInRealmView, UiRole, StackDrift, UpdateStatus, UpdateChannel, VersionHistory, PluginStoreEdit, PluginStoreEntry, PluginStoreReport, ConnectedAccountStatus, AppInstallation,
  InstanceTotals, UsageTotal, UserAdded, UserView, RealmSettings, RealmType, RealmView, RealmsEdit, RealmsView, PersonView, PreSort, QueueGate, QueueGateMode,
  InstanceUsageHistory, UsageGraphView, UsageHistory, UsageLimitPair, UsageLimits, UsageSeries, UsageTotalSeries, NotifierAction, NotifierActionResult,
  MachineHistory, MachineResource, MemoryAlert, DiskBudget, HopperDisk, HopperDiskPath, ResourceReading, WindowsLink, ResourceSeries, ContainerReading, ContainerReadings, MachineBoxes, PostgresReading, OpenFgaReading, SolrPart, StackResources, StackHistory, StackMetric, StackSeries,
  LaneChange, LaneRecommendation, LaneTuning, LaneTuningPlan, JobCostGroup, JobCostGrouping, JobCostProfile, JobCosts, ResourceCost,
  Login, LoginSettings, LoginStatus, LoginView,
  Allowed, FailureDecision, FailureRecordView, FailureSettings, FailuresView, KeptWorkView, StuckActResult, StuckCause, HandoffReason, HandoffResolution, HandoffResolutionAction, HandoffView, JobAssessment, KnownCause, ProblemView, SignatureStat,
  LaneReliability, PriorityLaneIdle, PriorityLaneSettings, PriorityLaneView, PriorityLanesView, QuestionView,
  ReviewDecision, ReviewEntry, ReviewItem, ReviewItemView, ReviewKind, ReviewSectionView, ReviewSettings, ReviewSettingsView, ReviewSignOffBy, ReviewStatus, ReviewVersion,
  FollowOnView, PathPick, PathSelection, PathTradeoff, ProposalPath, ProposalPathSet, SelectedPath,
  SectionKind, SectionSummary,
  ActorMachine, BlastRadiusSettings, BlastRadiusView, DiscoveryChanges, DiscoveryRecord, GateAt, MachineRadiusView, RadiusLevel, RadiusSource, Reach, UnconfirmedAs, TemplateRadius, TemplateProfileRadius,
  DecisionPoint, DecisionPointView, MinorDecisionMode, MinorDecisionOption, MinorDecisionPickView, MinorDecisionsView, TypesafeKeyView,
  ForkParent, ForkQuestion, JobPhase, PhaseShiftSettings, PhaseShiftSettingsView, PhaseSuggestion, QuestionFork, QuestionShifts, ShiftMode, ShiftThen,
  AutoAnswerSettings, AutoAnswerStats, AutoAnswerView, AutoParkSettings, ThreadAsk, ThreadAskPolicy, ThreadAskSettings, Confidence, AnswerHold, Escalation, EscalationHold, EscalationReason, GuardHit,
  ConfidenceSpread, DeciderRiskHold, RiskCategory, RiskCheck, RiskDecision,
  ApiGrantMinted, ApiGrantView, ApiTokenSettings, ApiTokenMinted, ApiTokenView, ScopePermission, ScopePreset, ScopeRegistry, ScopeSection, CredentialRequest, SharedSecretView, SystemSecretAudit, SystemSecretView, Template, TemplatePreview, TemplateView, SandboxApprovals, SandboxRequestState, SandboxRequestView, RememberedWriteView, VaultBackendView, VaultSecret, VaultView, ProfileAsk, InfraPlan, InfraPlanSettings, InfraWatchers, PlanApply, PlanView, OutOfBandMark, OutOfBandView, YoloModeSettings, YoloModeView, LandingBatchesView, LandingBatchRepoView, LandingBatchSettings, ChangeKind, ChangeKindSettings, ChangeRule, MergeGate, ContributionSettings, ShrinkGuardSettings, LandingCard, PullRequestCard, PullRequestsView, RepoChecks, RepoChecksQueued, RepoChecksView, UntrackedPullRequest, UntrackedReason,
  AccessDecisionRecord, AccessModelView, AccessState, AccessStatus, AccessView, Approval, Operation, OperationProfile, RelationshipTuple, RevokedApproval, Asset, AssetKind, Requester, RequesterRow,
  Artifact, ArtifactKind, ArtifactRevision, ArtifactRevisionView, ArtifactSettings, ArtifactShare, ArtifactView, ArtifactsView, HostLinkView,
  Tldr, TldrSettings,
  ItemComment, ItemEdit, TextChange,
  MasterKeyRotated, MasterKeyView,
  ActorCandidate, ActorCandidates, CandidateFrom, GitHubAccount, IntakeActorsView,
  BomGroup, BomPart, BomStatus, JobBom, JobGraph, JobGraphEdge, JobGraphEdgeKind, JobGraphNode, JobGraphNodeKind, JobGraphPullRequest, JobGraphTend, JobStage, JobTree,
} from '../../../src/domain/types.ts';

export type {
  AttachedMachine, Decision, DomainEvent, HostKeyOffer, InstanceSpec, Job, JobStatus, Lane, MachineDefaultsEdit, MachineEdit, MachineLaneEffect, MachinesConfig, SandboxesView, CleanupProblem, OptionChoice, PartAccount, PluginsEdit, PluginsReport,
  WindowsHost, WindowsHostsView,
  Question, QuestionAttempt, QuestionGatesView, RaisedBy, JobRulesView, QuestionStatus, RiskRuleView, Role, RoutingReport, RulesView, SelectableRole, ListRole, SourceStatus, UsageReading, UsageReport, UsageSourceReport, ToolAccount, ToolAccountMachine, ToolAccountsReport, ToolLogin, WebhookDelivery,
  WebhookSubscription, WebhooksEdit, SessionLengths, SessionUser, SessionView, SignInRealmView, UiRole, StackDrift, UpdateStatus, UpdateChannel, VersionHistory, PluginStoreEdit, PluginStoreEntry, PluginStoreReport, ConnectedAccountStatus, AppInstallation,
  InstanceTotals, UsageTotal, UserAdded, UserView, RealmSettings, RealmType, RealmView, RealmsEdit, RealmsView, PersonView, PreSort, QueueGate, QueueGateMode,
  InstanceUsageHistory, UsageGraphView, UsageHistory, UsageLimitPair, UsageLimits, UsageSeries, UsageTotalSeries, NotifierAction, NotifierActionResult,
  MachineHistory, MachineResource, MemoryAlert, DiskBudget, HopperDisk, HopperDiskPath, ResourceReading, WindowsLink, ResourceSeries, ContainerReading, ContainerReadings, MachineBoxes, PostgresReading, OpenFgaReading, SolrPart, StackResources, StackHistory, StackMetric, StackSeries,
  LaneChange, LaneRecommendation, LaneTuning, LaneTuningPlan, JobCostGroup, JobCostGrouping, JobCostProfile, JobCosts, ResourceCost,
  Login, LoginSettings, LoginStatus, LoginView,
  Allowed, FailureDecision, FailureRecordView, FailureSettings, FailuresView, KeptWorkView, StuckActResult, StuckCause, HandoffReason, HandoffResolution, HandoffResolutionAction, HandoffView, JobAssessment, KnownCause, ProblemView, SignatureStat,
  LaneReliability, PriorityLaneIdle, PriorityLaneSettings, PriorityLaneView, PriorityLanesView, QuestionView,
  ReviewDecision, ReviewEntry, ReviewItem, ReviewItemView, ReviewKind, ReviewSectionView, ReviewSettings, ReviewSettingsView, ReviewSignOffBy, ReviewStatus, ReviewVersion,
  FollowOnView, PathPick, PathSelection, PathTradeoff, ProposalPath, ProposalPathSet, SelectedPath,
  SectionKind, SectionSummary,
  ActorMachine, BlastRadiusSettings, BlastRadiusView, DiscoveryChanges, DiscoveryRecord, GateAt, MachineRadiusView, RadiusLevel, RadiusSource, Reach, UnconfirmedAs, TemplateRadius, TemplateProfileRadius,
  DecisionPoint, DecisionPointView, MinorDecisionMode, MinorDecisionOption, MinorDecisionPickView, MinorDecisionsView, TypesafeKeyView,
  ForkParent, ForkQuestion, JobPhase, PhaseShiftSettings, PhaseShiftSettingsView, PhaseSuggestion, QuestionFork, QuestionShifts, ShiftMode, ShiftThen,
  AutoAnswerSettings, AutoAnswerStats, AutoAnswerView, AutoParkSettings, ThreadAsk, ThreadAskPolicy, ThreadAskSettings, Confidence, AnswerHold, Escalation, EscalationHold, EscalationReason, GuardHit,
  ConfidenceSpread, DeciderRiskHold, RiskCategory, RiskCheck, RiskDecision,
  ApiGrantMinted, ApiGrantView, ApiTokenSettings, ApiTokenMinted, ApiTokenView, ScopePermission, ScopePreset, ScopeRegistry, ScopeSection, CredentialRequest, SharedSecretView, SystemSecretAudit, SystemSecretView, Template, TemplatePreview, TemplateView, SandboxApprovals, SandboxRequestState, SandboxRequestView, RememberedWriteView, VaultBackendView, VaultSecret, VaultView, ProfileAsk, InfraPlan, InfraPlanSettings, InfraWatchers, PlanApply, PlanView, OutOfBandMark, OutOfBandView, YoloModeSettings, YoloModeView, LandingBatchesView, LandingBatchRepoView, LandingBatchSettings, ChangeKind, ChangeKindSettings, ChangeRule, MergeGate, ContributionSettings, ShrinkGuardSettings, LandingCard, PullRequestCard, PullRequestsView, RepoChecks, RepoChecksQueued, RepoChecksView, UntrackedPullRequest, UntrackedReason,
  AccessDecisionRecord, AccessModelView, AccessState, AccessStatus, AccessView, Approval, Operation, OperationProfile, RelationshipTuple, RevokedApproval, Asset, AssetKind, Requester, RequesterRow,
  MasterKeyRotated, MasterKeyView,
  ActorCandidate, ActorCandidates, CandidateFrom, GitHubAccount, IntakeActorsView,
  BomGroup, BomPart, BomStatus, JobBom, JobGraph, JobGraphEdge, JobGraphEdgeKind, JobGraphNode, JobGraphNodeKind, JobGraphPullRequest, JobGraphTend, JobStage, JobTree,
  Artifact, ArtifactKind, ArtifactRevision, ArtifactRevisionView, ArtifactSettings, ArtifactShare, ArtifactView, ArtifactsView, HostLinkView,
  Tldr, TldrSettings,
  ItemComment, ItemEdit, TextChange,
};

export interface Queue {
  waiting: Job[];
  running: Job[];
  waitingAnswer: Job[];
  /** Jobs claimed as operator-led (issue #318). */
  operatorLed: Job[];
  /** Parked jobs (issue #501): on no lane, until picked up. */
  parked: Job[];
  /** Jobs on their own wait (issue #483): on no lane, their pane kept, until it ends. Absent from an older daemon. */
  waitingOn?: Job[];
  /** The locked entries (issue #355): failed jobs kept in the queue until run again or dismissed, highest priority first. */
  locked: Job[];
  /** Jobs ended in the last 24 hours, newest end first. */
  ended: Job[];
  /** How many work items are in each state (issue #1067): the work-item ledger's counts. Absent from an older daemon. */
  items?: Record<import('../../../src/domain/work-items.ts').WorkItemState, number>;
  /** How many work items are in flight, and in each part (issues #1113, #1164): the ledger's. Absent from an older daemon. */
  inFlight?: import('../../../src/domain/work-items.ts').InFlight;
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

export type MachineView = MachineSnapshot & { lanes: Lane[]; usage: UsageReading[]; hopperDisk?: HopperDisk };

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
  /** The last time the event loop was held for more than 2 s, for 10 minutes after (issue #1002): `during`, the routes in flight. */
  eventLoopStall?: { at: string; ms: number; during: string[] };
}

/** A subscription as GET /api/webhooks shows it: when its secret changed (or the variable one from before reads), and why it cannot sign (if so). Never a secret. */
export type WebhookView = WebhookSubscription & { secretProblem?: string };

/** GET /api/webhooks, and the answer to POST /ui/api/webhooks. */
export interface WebhooksView {
  subscriptions: WebhookView[];
  /** Only in the answer to the edit that made it (add with no secret typed in, rotate; issue #451): shown once. */
  generatedSecret?: string;
}

export type { GitHubCallKind, HourlyCalls, RateBucket, RateLimiterSettings, RateLimiterView } from '../../../src/domain/github-rate-limit.ts';
export type { DeliverySecretView, GitHubDeliveriesView } from '../../../src/domain/github-deliveries.ts';
export type { AfterAnswerTiming, TimingSpread } from '../../../src/domain/sources.ts';
export type { CredentialMeta, RemoteAccessChange, RemoteAccessLinks, RemoteAccessProvider, RemoteAccessState, RemoteAccessStatus, RemoteAccessView } from '../../../src/domain/remote-access.ts';
export type { GitHubWatch, GitHubWatchSettings, GitHubWatchView } from '../../../src/domain/github-watch.ts';
export type { ComponentWatcherSettings, ComponentWatcherView, ComponentWatchersView, DriftItem, DriftView } from '../../../src/domain/drift.ts';
export type { DirectJob, DirectJobInput, DirectJobQuestion, DirectJobView } from '../../../src/domain/direct-jobs.ts';
export type { VaultGrant, VaultGrantAsk, VaultGrantItem, VaultGrantView } from '../../../src/domain/vault-grants.ts';
export type { SearchAnswer, SearchFacet, SearchState, SearchStatus, SuggestAnswer } from '../../../src/domain/search.ts';
export type { JobTranscript, TranscriptPart, TranscriptTurn } from '../../../src/domain/transcript.ts';
export type { Promotion, PromotionArtifact, PromotionDraft, PromotionRequest, PromotionTarget, PromotionView, ScanFinding } from '../../../src/domain/promotions.ts';
export type { JobNote, JobNoteState, NoteDelivery } from '../../../src/domain/job-notes.ts';
export type { AllowedHostsView } from '../../../src/domain/allowed-hosts.ts';
export type { InFlight, WorkItem, WorkItemState } from '../../../src/domain/work-items.ts';
export type { HeaderBadge, HeaderBadgeSettings } from '../../../src/domain/types.ts';
export type { PullRequestDiff, PullRequestDiffFile } from '../../../src/domain/pull-request-diff.ts';
