// The HTTP API's shapes as the UI reads them. Domain types come from src/domain/types.ts as
// type-only imports: the wire contract has one definition, and nothing of src/ is bundled.
import type {
  AttachedMachine, PlaygroundLimits, PlaygroundSandbox, PlaygroundView, Decision, DomainEvent, HostKeyOffer, InstanceSpec, Job, JobStatus, Lane, MachineDefaultsEdit, MachineEdit, MachineLaneEffect, MachineSnapshot, MachinesConfig, SandboxesView, CleanupProblem, OptionChoice, PartAccount, PluginsEdit, PluginsReport,
  WindowsHost, WindowsHostsView, ClusterOverride, ClustersView,
  Question, QuestionAttempt, QuestionGatesView, RaisedBy, JobRulesView, RepoJobRulesView, QuestionStatus, RiskRuleView, Role, RoutingReport, RulesView, SelectableRole, ListRole, SourceStatus, JobActMarker, UsageReading, UsageReport, UsageSourceReport, ToolAccount, ToolAccountMachine, ToolAccountsReport, ToolLogin, WebhookDelivery,
  WebhookSubscription, WebhooksEdit, SessionLengths, SessionUser, SessionView, SignInRealmView, UiRole, StackDrift, UpdateStatus, UpdateChannel, VersionHistory, PluginStoreEdit, PluginStoreEntry, PluginStoreReport, ConnectedAccountStatus, AppInstallation,
  InstanceTotals, UsageTotal, UserAdded, UserView, RealmSettings, RealmType, RealmView, RealmsEdit, RealmsView, PersonView, LocalAccountView, LocalAccountsView, LocalAccountsEdit, PasskeyView, PasskeysView, PreSort, QueueGate, QueueGateMode,
  InstanceUsageHistory, UsageGraphView, UsageHistory, UsageLimitPair, UsageLimits, UsageSeries, UsageTotalSeries, NotifierAction, NotifierActionResult,
  MachineHistory, MachineResource, MemoryAlert, DiskBudget, DiskDefaults, HopperDisk, HopperDiskPath, Leftover, LeftoverView, MachineLeftovers, ResourceReading, WindowsLink, ResourceSeries, ContainerReading, ContainerReadings, MachineBoxes, PostgresReading, OpenFgaReading, SolrPart, StackResources, StackHistory, StackMetric, StackSeries, TelemetrySummary, TimingStat, GitHubUseStat,
  LaneChange, LaneRecommendation, LaneTuning, LaneTuningPlan, JobCostGroup, JobCostGrouping, JobCostProfile, JobCosts, ResourceCost,
  LastAccount, Login, LoginSettings, LoginStatus, LoginView,
  Allowed, FailureDecision, FailureRecordView, FailureSettings, FailuresView, KeptReason, KeptWorkView, StuckActResult, StuckCause, HandoffReason, HandoffResolution, HandoffResolutionAction, HandoffView, JobAssessment, KnownCause, ProblemView, SignatureStat,
  LaneReliability, PriorityLaneIdle, PriorityLaneSettings, PriorityLaneView, PriorityLanesView, QuestionView,
  ReviewDecision, ReviewEntry, ReviewItem, ReviewItemView, ReviewKind, ReviewSectionView, ReviewSettings, ReviewSettingsView, ReviewSignOffBy, ReviewStatus, ReviewVersion,
  FollowOnView, PathPick, PathSelection, PathTradeoff, ProposalPath, ProposalPathSet, SelectedPath,
  SectionKind, SectionSummary,
  ActorMachine, BlastRadiusSettings, BlastRadiusView, DiscoveryChanges, DiscoveryRecord, GateAt, MachineRadiusView, RadiusLevel, RadiusSource, Reach, UnconfirmedAs, TemplateRadius, TemplateProfileRadius,
  DecisionPoint, DecisionPointView, MinorDecisionMode, MinorDecisionOption, MinorDecisionPickView, MinorDecisionsView, TypesafeKeyView,
  ForkQuestion, JobPhase, PhaseShiftSettings, PhaseShiftSettingsView, PhaseSuggestion, QuestionFork, QuestionShifts, ShiftMode, ShiftThen,
  AutoAnswerSettings, AutoAnswerStats, AutoAnswerView, PreemptionSettings, JobPreempted, ThreadAsk, ThreadAskPolicy, ThreadAskSettings, Confidence, AnswerHold, Escalation, EscalationHold, EscalationReason, GuardHit,
  ConfidenceSpread, DeciderRiskHold, RiskCategory, RiskCheck, RiskDecision,
  ApiGrantMinted, ApiGrantView, GrantLimits, DeviceGrantView, ApiTokenSettings, ApiTokenMinted, ApiTokenView, ScopePermission, ScopePreset, ScopeRegistry, ScopeSection, CredentialRequest, SharedSecretView, SystemSecretAudit, SystemSecretView, Template, TemplatePreview, TemplateView, SandboxApprovals, SandboxRequestState, SandboxRequestView, RunCardView, RememberedWriteView, VaultBackendView, VaultSecret, VaultView, ProfileAsk, InfraPlan, InfraPlanSettings, InfraWatchers, PlanApply, PlanView, OutOfBandMark, OutOfBandView, YoloModeSettings, YoloModeView, LandingBatchesView, LandingBatchRepoView, LandingBatchSettings, ChangeKind, ChangeKindSettings, ChangeRule, MergeGate, ContributionSettings, ShrinkGuardSettings, LandingCard, ChecksProblem, PullRequestCard, PullRequestsView, RepoChecks, RepoChecksQueued, RepoChecksView, UntrackedPullRequest, UntrackedReason,
  AccessDecisionRecord, AccessModelView, AccessState, AccessStatus, AccessView, Approval, MinTrust, Operation, OperationProfile, RelationshipTuple, RevokedApproval, Asset, AssetKind, Requester, RequesterRow,
  Artifact, ArtifactKind, ArtifactRevision, ArtifactRevisionView, ArtifactSettings, ArtifactShare, ArtifactView, ArtifactsView, HostLinkView,
  Tldr, TldrSettings,
  ItemComment, ItemEdit, TextChange,
  MasterKeyRotated, MasterKeyView,
  ActorCandidate, ActorCandidates, CandidateFrom, GitHubAccount, IntakeActorsView, IntakeAutoApproval, DeclineChoice, IntakeDeclineDefaults, IntakeStrictness, Strictness, SandboxStrictness, SandboxStrictnessLevel,
  BomGroup, BomPart, BomStatus, JobBom, JobGraph, JobGraphEdge, JobGraphEdgeKind, JobGraphNode, JobGraphNodeKind, JobGraphPullRequest, JobGraphTend, JobStage, JobTree, PlanArtifactType, PlanArtifactView, PlanJob, PlanPiece, PlanStatus, PlanSync, PlanTask, WorkPlan, WorkPlanSummary,
} from '../../../src/domain/types.ts';
import type { GitLabAccountStatus } from '../../../src/domain/gitlab-account.ts';
import type { PodmanHost, PodmanHostStatus, PodmanHostsStatusView, PodmanHostsView } from '../../../src/domain/podman-hosts.ts';

export type { GitLabAccountStatus, PodmanHost, PodmanHostStatus, PodmanHostsStatusView, PodmanHostsView };
export type {
  AttachedMachine, PlaygroundLimits, PlaygroundSandbox, PlaygroundView, Decision, DomainEvent, HostKeyOffer, InstanceSpec, Job, JobStatus, Lane, MachineDefaultsEdit, MachineEdit, MachineLaneEffect, MachinesConfig, SandboxesView, CleanupProblem, OptionChoice, PartAccount, PluginsEdit, PluginsReport,
  WindowsHost, WindowsHostsView, ClusterOverride, ClustersView,
  Question, QuestionAttempt, QuestionGatesView, RaisedBy, JobRulesView, RepoJobRulesView, QuestionStatus, RiskRuleView, Role, RoutingReport, RulesView, SelectableRole, ListRole, SourceStatus, JobActMarker, UsageReading, UsageReport, UsageSourceReport, ToolAccount, ToolAccountMachine, ToolAccountsReport, ToolLogin, WebhookDelivery,
  WebhookSubscription, WebhooksEdit, SessionLengths, SessionUser, SessionView, SignInRealmView, UiRole, StackDrift, UpdateStatus, UpdateChannel, VersionHistory, PluginStoreEdit, PluginStoreEntry, PluginStoreReport, ConnectedAccountStatus, AppInstallation,
  InstanceTotals, UsageTotal, UserAdded, UserView, RealmSettings, RealmType, RealmView, RealmsEdit, RealmsView, PersonView, LocalAccountView, LocalAccountsView, LocalAccountsEdit, PasskeyView, PasskeysView, PreSort, QueueGate, QueueGateMode,
  InstanceUsageHistory, UsageGraphView, UsageHistory, UsageLimitPair, UsageLimits, UsageSeries, UsageTotalSeries, NotifierAction, NotifierActionResult,
  MachineHistory, MachineResource, MemoryAlert, DiskBudget, DiskDefaults, HopperDisk, HopperDiskPath, Leftover, LeftoverView, MachineLeftovers, ResourceReading, WindowsLink, ResourceSeries, ContainerReading, ContainerReadings, MachineBoxes, PostgresReading, OpenFgaReading, SolrPart, StackResources, StackHistory, StackMetric, StackSeries, TelemetrySummary, TimingStat, GitHubUseStat,
  LaneChange, LaneRecommendation, LaneTuning, LaneTuningPlan, JobCostGroup, JobCostGrouping, JobCostProfile, JobCosts, ResourceCost,
  LastAccount, Login, LoginSettings, LoginStatus, LoginView,
  Allowed, FailureDecision, FailureRecordView, FailureSettings, FailuresView, KeptReason, KeptWorkView, StuckActResult, StuckCause, HandoffReason, HandoffResolution, HandoffResolutionAction, HandoffView, JobAssessment, KnownCause, ProblemView, SignatureStat,
  LaneReliability, PriorityLaneIdle, PriorityLaneSettings, PriorityLaneView, PriorityLanesView, QuestionView,
  ReviewDecision, ReviewEntry, ReviewItem, ReviewItemView, ReviewKind, ReviewSectionView, ReviewSettings, ReviewSettingsView, ReviewSignOffBy, ReviewStatus, ReviewVersion,
  FollowOnView, PathPick, PathSelection, PathTradeoff, ProposalPath, ProposalPathSet, SelectedPath,
  SectionKind, SectionSummary,
  ActorMachine, BlastRadiusSettings, BlastRadiusView, DiscoveryChanges, DiscoveryRecord, GateAt, MachineRadiusView, RadiusLevel, RadiusSource, Reach, UnconfirmedAs, TemplateRadius, TemplateProfileRadius,
  DecisionPoint, DecisionPointView, MinorDecisionMode, MinorDecisionOption, MinorDecisionPickView, MinorDecisionsView, TypesafeKeyView,
  ForkQuestion, JobPhase, PhaseShiftSettings, PhaseShiftSettingsView, PhaseSuggestion, QuestionFork, QuestionShifts, ShiftMode, ShiftThen,
  AutoAnswerSettings, AutoAnswerStats, AutoAnswerView, PreemptionSettings, JobPreempted, ThreadAsk, ThreadAskPolicy, ThreadAskSettings, Confidence, AnswerHold, Escalation, EscalationHold, EscalationReason, GuardHit,
  ConfidenceSpread, DeciderRiskHold, RiskCategory, RiskCheck, RiskDecision,
  ApiGrantMinted, ApiGrantView, GrantLimits, DeviceGrantView, ApiTokenSettings, ApiTokenMinted, ApiTokenView, ScopePermission, ScopePreset, ScopeRegistry, ScopeSection, CredentialRequest, SharedSecretView, SystemSecretAudit, SystemSecretView, Template, TemplatePreview, TemplateView, SandboxApprovals, SandboxRequestState, SandboxRequestView, RunCardView, RememberedWriteView, VaultBackendView, VaultSecret, VaultView, ProfileAsk, InfraPlan, InfraPlanSettings, InfraWatchers, PlanApply, PlanView, OutOfBandMark, OutOfBandView, YoloModeSettings, YoloModeView, LandingBatchesView, LandingBatchRepoView, LandingBatchSettings, ChangeKind, ChangeKindSettings, ChangeRule, MergeGate, ContributionSettings, ShrinkGuardSettings, LandingCard, ChecksProblem, PullRequestCard, PullRequestsView, RepoChecks, RepoChecksQueued, RepoChecksView, UntrackedPullRequest, UntrackedReason,
  AccessDecisionRecord, AccessModelView, AccessState, AccessStatus, AccessView, Approval, MinTrust, Operation, OperationProfile, RelationshipTuple, RevokedApproval, Asset, AssetKind, Requester, RequesterRow,
  MasterKeyRotated, MasterKeyView,
  ActorCandidate, ActorCandidates, CandidateFrom, GitHubAccount, IntakeActorsView, IntakeAutoApproval, DeclineChoice, IntakeDeclineDefaults, IntakeStrictness, Strictness, SandboxStrictness, SandboxStrictnessLevel,
  BomGroup, BomPart, BomStatus, JobBom, JobGraph, JobGraphEdge, JobGraphEdgeKind, JobGraphNode, JobGraphNodeKind, JobGraphPullRequest, JobGraphTend, JobStage, JobTree, PlanArtifactType, PlanArtifactView, PlanJob, PlanPiece, PlanStatus, PlanSync, PlanTask, WorkPlan, WorkPlanSummary,
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
  /** The critical priority (issue #2203): a job at or above it is a critical job, tracked on every page; 0: off. Absent from an older daemon. */
  criticalPriority?: number;
  /** Each waiting job's effective priority (issue #1776): its priority with any boost. Absent from an older daemon. */
  effectivePriority?: Record<string, number>;
}

/** GET /api/logins (issue #476): the server's time for the countdowns, the logins settings, the logins newest first. */
export interface LoginsRead {
  now: string;
  settings: LoginSettings;
  logins: LoginView[];
}

export type MachineView = MachineSnapshot & { lanes: Lane[]; usage: UsageReading[]; hopperDisk?: HopperDisk; leftovers?: MachineLeftovers; cleanupLeftovers?: import('../../../src/domain/resource-ledger.ts').MachineCleanupLeftovers; credentialAcceptance?: import('../../../src/domain/machine-credentials.ts').CredentialAcceptance; credentialHeld?: boolean; heavySteps?: import('../../../src/domain/heavy-steps.ts').HeavyStepView[] };

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
  eventLoopStall?: { at: string; ms: number; during: string[]; store?: { ms: number; calls: { what: string; ms: number; count: number }[] }; processes?: { count: number; programs: { what: string; count: number }[] }; held?: { afterMs: number; frames: string[] }[]; memory?: { rssMb: number; heapMb: number } };
  /** The hopper's zombie and orphaned child processes, while more than 5 (issue #2623): it runs with no init. */
  strayChildren?: { zombies: number; orphans: number; programs: string[] };
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
export type { DeliveryGates, DeliveryRepo, DeliverySettings, DeliverySettingsView } from '../../../src/domain/delivery-settings.ts';
export type { DeliveryForecast, DeliveryForecastView, PromotionSetForecastView, StepForecast } from '../../../src/domain/delivery-forecast.ts';
export type { AccuracyOverTime, DeliveryLedgerView } from '../../../src/domain/forecast-accuracy.ts';
export type { DeliveryTracksView, DeploymentRecord, Hop, KeptTrack } from '../../../src/domain/kept-tracks.ts';
export type { DeliverySecretView, GitHubDeliveriesView } from '../../../src/domain/github-deliveries.ts';
export type { AfterAnswerTiming, TimingSpread } from '../../../src/domain/sources.ts';
export type { CredentialMeta, RemoteAccessChange, RemoteAccessLinks, RemoteAccessProvider, RemoteAccessState, RemoteAccessStatus, RemoteAccessView } from '../../../src/domain/remote-access.ts';
export type { GitHubWatch, GitHubWatchSettings, GitHubWatchView } from '../../../src/domain/github-watch.ts';
export type { ComponentWatcherSettings, ComponentWatcherView, ComponentWatchersView, DriftItem, DriftView } from '../../../src/domain/drift.ts';
export type { DirectJob, DirectJobInput, DirectJobQuestion, DirectJobView, DirectQueryState, DirectQueryView } from '../../../src/domain/direct-jobs.ts';
export type { PushRequirement } from '../../../src/domain/push-requirements.ts';
export type { PushRequirementMetrics } from '../../../src/domain/push-requirement-metrics.ts';
export type { ActionAskView, ActionGrantView } from '../../../src/domain/action-grants.ts';
export type { BastionView } from '../../../src/domain/bastions.ts';
export type { VaultGrant, VaultGrantAsk, VaultGrantItem, VaultGrantView } from '../../../src/domain/vault-grants.ts';
export type { SearchAnswer, SearchFacet, SearchState, SearchStatus, SuggestAnswer } from '../../../src/domain/search.ts';
export type { JobTranscript, TranscriptPart, TranscriptTurn } from '../../../src/domain/transcript.ts';
export type { JobTokenView, TokenRollupRow, TokenTotals } from '../../../src/domain/token-usage.ts';
export type { TokenBudgetSettings } from '../../../src/domain/token-budget.ts'; export type { JobBudget, ModelBudget, ModelRoutingSettings } from '../../../src/domain/model-routing.ts';
export type { BugReportRecommendation, RecommendationState, ReviewDefect } from '../../../src/domain/review-defects.ts';
export type { GradeGroup, GradeLine, GradeSettings, GradeSignal, GradesView, JobGradeView, UserGrade } from '../../../src/domain/grades.ts';
export type { CompletionReview, CompletionReviewSettings, Restart, RestartKind, ReviewOutcome, ReviewStage, StageTime, Suggestion, SuggestionArea } from '../../../src/domain/completion-review.ts';
export type { PerMergedPullRequest, TokenWaste, TokenWasteKind, TokenWasteLine } from '../../../src/domain/token-waste.ts';
export type { Promotion, PromotionArtifact, PromotionDraft, PromotionRequest, PromotionTarget, PromotionView, ScanFinding } from '../../../src/domain/promotions.ts';
export type { JobNote, JobNoteState, NoteDelivery } from '../../../src/domain/job-notes.ts';
export type { AllowedHostsView } from '../../../src/domain/allowed-hosts.ts';
export type { TelemetrySettings, TelemetrySettingsView, TelemetrySignal } from '../../../src/domain/telemetry-settings.ts';
export type { CloudConnectionView, CloudLinkView, RegistrationCodeMinted } from '../../../src/domain/cloud-link.ts';
export type { HopperIoState } from '../../../src/domain/hopper-io-state.ts';
export type { InFlight, WorkItem, WorkItemState } from '../../../src/domain/work-items.ts';
export type { HeaderBadge, HeaderBadgeSettings } from '../../../src/domain/types.ts';
export type { WaitOn, WaitCheck } from '../../../src/domain/types.ts';
export type { PullRequestDiff, PullRequestDiffFile } from '../../../src/domain/pull-request-diff.ts';
export type { MemoryEntryView, MemoryKind, MemoryRepoSetting, MemorySettings, MemoryState, RepoMemoryView } from '../../../src/domain/repo-memory.ts';
