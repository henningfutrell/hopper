// The settings repositories' ports, apart from store.ts for its size (re-exported there): a user's settings and the
// instance's. Each value is absent until set.

import type { RateLimiterSettings } from './github-rate-limit.ts';
import type { IntakeActorSettings } from './intake-origin.ts';
import type { IntakeAutoApproval } from './intake-auto-approve.ts';
import type { IntakeDeclineDefaults } from './intake-decline.ts';
import type { IntakeMigration } from './intake.ts';
import type { TaggedRecord } from './tagged.ts';
import type { GitLabAccountRecord } from './gitlab-account.ts'; import type { NewRepositoryRecord } from './new-repositories.ts';
import type { ReadPolicy } from './read-policy.ts'; import type { DeliverySettings } from './delivery-settings.ts';
import type { SandboxApprovals } from './sandbox-approvals.ts';
import type { RememberedWrite } from './remembered-writes.ts';
import type { RemoteAccessSettings } from './remote-access.ts';
import type { MachineDrains } from './machines.ts';
import type { SandboxHost } from './sandbox-host.ts';
import type { CloudLinkSettings, CloudRegistrationCode } from './cloud-link.ts';
import type { TelemetrySettings } from './telemetry-settings.ts';
import type { MemoryAlert } from './machine-history.ts'; import type { DiskBudget } from './hopper-disk.ts'; import type { DiskDefaults } from './disk-defaults.ts'; import type { HeaderBadgeSettings } from './header-badges.ts'; import type { PushRequirement } from './push-requirements.ts';
import type {
  AutoAnswerSettings, PreemptionSettings, ComponentWatcherSettings, GitHubWatchSettings, BlastRadiusSettings, ConnectedAccountKey, LaneId, LaneDismissals, LaneTuningSettings, DiscoveryRecord, FailureSettings, LoginExpiryAction, MinorDecisionSettings, NamedCause, PhaseShiftSettings,
  PluginInstall, PluginStoreSource, PriorityLaneSettings, QueueGate, ReviewKind, ReviewSettings, ThreadAskSettings, TldrSettings, UpdateSettings, UsageGraphView, UsageLimitPair, YoloModeSettings, ContributionSettings, ShrinkGuardSettings, LandingBatchSettings,
} from './types.ts';

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
  /** The repositories a connected account's jobs may use (issue #321), by the account's key (issue #1448); empty: none chosen. */
  getJobRepositories(key: ConnectedAccountKey): string[];
  setJobRepositories(key: ConnectedAccountKey, repositories: readonly string[]): void;
  /** A connected account's new-repository policy, what it has reached and its open asks (issue #2795), by its key; never set: the default policy, never read. */
  getNewRepositories(key: ConnectedAccountKey): NewRepositoryRecord;
  setNewRepositories(key: ConnectedAccountKey, record: NewRepositoryRecord): void;
  /** The user's GitLab account (issue #1448 part 2), never its token; absent: none attached. */
  getGitLabAccount(): GitLabAccountRecord | undefined;
  setGitLabAccount(account: GitLabAccountRecord | null): void;
  /** The usage graph's range and step the user chose (issue #385); absent: never chosen. */
  getUsageGraphView(): UsageGraphView | undefined;
  setUsageGraphView(view: UsageGraphView): void;
  /** How many days usage samples are kept (issue #385); absent: never chosen. */
  getHistoryRetentionDays(): number | undefined;
  setHistoryRetentionDays(days: number): void;
  /** The memory alert (issue #868); absent: off, or never set. */
  getMemoryAlert(): MemoryAlert | undefined;
  setMemoryAlert(alert: MemoryAlert | null): void;
  /** The header badges the user chose (issue #1181); absent: never chosen, one Lanes badge. */
  getHeaderBadges(): HeaderBadgeSettings | undefined;
  setHeaderBadges(settings: HeaderBadgeSettings): void;
  /** The disk budget (issue #1120); absent: none, or never set. */
  getDiskBudget(): DiskBudget | undefined;
  setDiskBudget(budget: DiskBudget | null): void;
  /** The disk defaults (issue #2494): what every machine takes where its own options are silent; absent: none, or never set. */
  getDiskDefaults(): DiskDefaults | undefined;
  setDiskDefaults(defaults: DiskDefaults | null): void;
  /** The hopper's default push requirements (issue #2555); none when never set. */
  getPushRequirementDefaults(): PushRequirement[];
  setPushRequirementDefaults(requirements: readonly PushRequirement[]): void;
  /** The usage limits the user set (issue #522); absent: never set, the defaults apply. */
  getUsageLimits(): UsageLimitPair | undefined;
  setUsageLimits(limits: UsageLimitPair): void;
  /** Each machine's lane tuning settings (issue #688); a machine absent: never saved, the defaults apply. */
  getLaneTuning(): LaneTuningSettings;
  setLaneTuning(settings: LaneTuningSettings): void;
  /** Each machine's dismissed lane recommendation (issue #688); a machine absent: none dismissed. */
  getLaneDismissals(): LaneDismissals;
  setLaneDismissals(dismissals: LaneDismissals): void;
  /** The drained machines (issue #1511); a machine absent: not drained. */
  getMachineDrains(): MachineDrains;
  setMachineDrains(drains: MachineDrains): void;
  /** The sandbox host (issue #2272); absent: never set. `hosts` empty: cleared, sandboxes start where they did before. */
  getSandboxHost(): SandboxHost | undefined;
  setSandboxHost(host: SandboxHost): void;
  /** The priority lane settings the user saved (issue #535); absent: never saved, the defaults apply. */
  getPriorityLanes(): PriorityLaneSettings | undefined;
  setPriorityLanes(settings: PriorityLaneSettings): void;
  /** The priority lanes last chosen (issue #535), so a restart keeps them and their hysteresis; absent: none yet. */
  getPriorityLaneChoice(): LaneId[] | undefined;
  setPriorityLaneChoice(lanes: readonly LaneId[]): void;
  /** The blast-radius settings the user saved (issue #542); absent: never saved, the defaults apply. */
  getBlastRadius(): BlastRadiusSettings | undefined;
  setBlastRadius(settings: BlastRadiusSettings): void;
  /** The read policy (issue #716): the assets the hopper approves read on with no person, for a template a job asks for; absent: never set, none. */
  getReadPolicy(): ReadPolicy | undefined;
  setReadPolicy(policy: ReadPolicy): void;
  /** The sandbox approval toggles (issue #991): skip template approval, skip sandbox approval; absent: never set, both off. */
  getSandboxApprovals(): SandboxApprovals | undefined;
  setSandboxApprovals(approvals: SandboxApprovals): void;
  /** A person's write, sync and apply approvals, remembered per asset and access (issue #1001); none at first. Ended ones included: liveWrites reads them. */
  getRememberedWrites(): RememberedWrite[];
  setRememberedWrites(list: readonly RememberedWrite[]): void;
  /** A person's action grants (issue #2206): an AWS action on a resource for an aws-role; none at first. Ended ones included: liveGrants reads them. */
  getActionGrants(): import('./action-grants.ts').ActionGrant[];
  setActionGrants(list: readonly import('./action-grants.ts').ActionGrant[]): void;
  /** Sandbox strictness, brake 2 (issue #655 part 8); undefined: never set, so standard everywhere. */
  getSandboxStrictness(): import('./sandbox-strictness.ts').SandboxStrictness | undefined;
  setSandboxStrictness(settings: import('./sandbox-strictness.ts').SandboxStrictness): void;
  /** A machine's last discovery (issue #542); absent: never discovered. */
  getDiscovery(machineId: string): DiscoveryRecord | undefined;
  setDiscovery(record: DiscoveryRecord): void;
  /** The user's claim holder id (issue #440): made, random, the first time it is asked, then kept. */
  claimHolder(): string;
  /** A job source's intake migration (issue #440), by its instance name; absent: not run yet. */
  getIntakeMigration(source: string): IntakeMigration | undefined;
  setIntakeMigration(source: string, migration: IntakeMigration): void;
  /** What a job source keeps of its tagged items (issue #1141), by its instance name; absent: nothing kept yet. */
  getTaggedRecord(source: string): TaggedRecord | undefined;
  setTaggedRecord(source: string, record: TaggedRecord): void;
  /** What a job does when its login expires (issue #476); absent: never chosen. */
  getLoginExpiry(): LoginExpiryAction | undefined;
  setLoginExpiry(action: LoginExpiryAction): void;
  /** How long before a login's code runs out the Logins view warns, in seconds (issue #477); absent: never chosen. */
  getLoginWarnSec(): number | undefined;
  setLoginWarnSec(seconds: number): void;
  /** A review section's settings (issues #537, #543); absent: never saved. */
  getReviewSettings(kind: ReviewKind): ReviewSettings | undefined;
  setReviewSettings(kind: ReviewKind, settings: ReviewSettings): void;
  /** The phase-shift settings (issue #548); absent: never set. */
  getPhaseShifts(): PhaseShiftSettings | undefined;
  setPhaseShifts(settings: PhaseShiftSettings): void;
  /** Auto-answer (issue #632): whether a level's answer goes into the job with no person, and at what confidence; absent: never set. */
  getAutoAnswer(): AutoAnswerSettings | undefined;
  setAutoAnswer(settings: AutoAnswerSettings): void;
  /** Auto-park (issue #650): how long a question waits on a person before its job parks by itself; absent: never set. */
  /** The token budget (issue #2302, part 3): the most one job may spend before it is paused; absent: never set (no cap). */
  getTokenBudget(): Partial<import('./token-budget.ts').TokenBudgetSettings> | undefined;
  setTokenBudget(settings: import('./token-budget.ts').TokenBudgetSettings): void;
  /** Preemption (issue #1525): whether a higher-priority job takes a running job's lane, and its minimum run time; absent: never set (on, 10 min). */
  getPreemption(): PreemptionSettings | undefined;
  setPreemption(settings: PreemptionSettings): void;
  /** Asking on the issue thread (issue #435): the policy for own and other repositories; absent: never set. */
  getThreadAsk(): ThreadAskSettings | undefined;
  setThreadAsk(settings: ThreadAskSettings): void;
  /** The TL;DR setting (issue #569); absent: never set, on. */
  getTldr(): TldrSettings | undefined;
  setTldr(settings: TldrSettings): void;
  /** Yolo mode (issue #579): whether jobs may merge their own pull requests; absent: never set (off). */
  /** GitHub watches (issue #427): how often each polls; absent: never set, the default. */
  getGitHubWatch(): GitHubWatchSettings | undefined;
  setGitHubWatch(settings: GitHubWatchSettings): void;
  /** Component watchers (issue #1077): whether a drift files a drift issue; absent: never set, off. */
  getComponentWatchers(): ComponentWatcherSettings | undefined;
  setComponentWatchers(settings: ComponentWatcherSettings): void;
  getYoloMode(): YoloModeSettings | undefined;
  setYoloMode(settings: YoloModeSettings): void;
  /** Landing batches (issue #1073): per repository, its tested branch and when a batch run starts; absent: never set (none). */
  getLandingBatches(): LandingBatchSettings | undefined;
  setLandingBatches(settings: LandingBatchSettings): void;
  /** Delivery settings (issue #2554 part 3): per repository, its promotion set schedule and delivery gates; absent: never set (none). */
  getDeliverySettings(): DeliverySettings | undefined; setDeliverySettings(settings: DeliverySettings): void;
  /** Contribution (issue #429): whether jobs may work through a fork of a repository their user cannot push to; absent: off. */
  getContribution(): ContributionSettings | undefined;
  setContribution(settings: ContributionSettings): void;
  /** The shrink guard (issue #1096): the percent of a file's lines a job's push that brings in its base branch may take; absent: 50. */
  getShrinkGuard(): ShrinkGuardSettings | undefined;
  setShrinkGuard(settings: ShrinkGuardSettings): void;
  /** The infra plans' settings (issue #870 part 3): whether the hopper approves a low-risk uat plan itself; absent: off. */
  getInfraPlans(): import('./infra-plans.ts').InfraPlanSettings | undefined;
  setInfraPlans(settings: import('./infra-plans.ts').InfraPlanSettings): void;
  /** The environment watchers (issue #870 part 4): who is told of each plan and apply, by environment; absent: none. */
  getInfraWatchers(): import('./infra-watchers.ts').InfraWatchers | undefined;
  setInfraWatchers(watchers: import('./infra-watchers.ts').InfraWatchers): void;
  /** The intake's trusted actors (issue #652); undefined: none named, so the connected login only. */
  getIntakeActors(): IntakeActorSettings | undefined;
  setIntakeActors(settings: IntakeActorSettings): void;
  /** Auto-approval at intake (issue #1268); undefined: never set, so on, with no app listed. */
  getIntakeAutoApproval(): IntakeAutoApproval | undefined;
  setIntakeAutoApproval(settings: IntakeAutoApproval): void;
  /** The choice Decline offers first (issue #1710); undefined: never set. */
  getIntakeDecline(): IntakeDeclineDefaults | undefined;
  setIntakeDecline(settings: IntakeDeclineDefaults): void;
  /** Intake strictness, brake 1 (issue #655 part 3); undefined: never set, so standard everywhere. */
  getIntakeStrictness(): import('./intake-strictness.ts').IntakeStrictness | undefined;
  setIntakeStrictness(settings: import('./intake-strictness.ts').IntakeStrictness): void;
  /** The job repositories whose "Add PR checks" recommendation the person dismissed (issue #677), `owner/repo` lowercased; none: []. */
  getRepoChecksDismissed(): string[];
  setRepoChecksDismissed(repos: string[]): void;
  /** The one-time backfills that completed on this store (issue #637: `done-check`), each with when. */
  getBackfills(): Record<string, string>;
  setBackfills(done: Record<string, string>): void;
  /** The failure assessor's settings (issue #509); absent: never set. */
  getFailureSettings(): FailureSettings | undefined;
  setFailureSettings(settings: FailureSettings): void;
  /** Each decision point's mode and threshold (issue #550); a point never set is absent. */
  getMinorDecisionSettings(): Partial<MinorDecisionSettings>;
  setMinorDecisionSettings(settings: MinorDecisionSettings): void;
  /** The causes a person named for signatures (issue #509). */
  getNamedCauses(): NamedCause[];
  setNamedCauses(causes: readonly NamedCause[]): void;
}

/** The instance's settings (in the instance schema): self-update, the plugin store and its store installs. */
export interface InstanceSettingsRepository {
  /** Self-update settings an admin chose; absent fields were never set. */
  getUpdateSettings(): Partial<UpdateSettings>;
  setUpdateSettings(patch: Partial<UpdateSettings>): void;
  /** The store installs, by id (issue #93). */
  getPluginInstalls(): PluginInstall[];
  setPluginInstalls(installs: readonly PluginInstall[]): void;
  /** The shared rate limiter's settings (issue #436); absent fields were never set, their defaults apply. */
  getGitHubRateLimiter(): Partial<RateLimiterSettings>;
  setGitHubRateLimiter(settings: RateLimiterSettings): void;
  /** The plugin store setting (issue #445); undefined: never set. */
  getPluginStoreSource(): PluginStoreSource | undefined;
  setPluginStoreSource(source: PluginStoreSource): void;
  /** This hopper's id (issue #603), made at its first ask and kept: the label of the sandbox boxes it launches. */
  instanceId(): string;
  /** The master key's fingerprint (issue #659): an HMAC under the key of a fixed label, never the key; undefined: none yet. */
  masterKeyFingerprint(): string | undefined;
  setMasterKeyFingerprint(fingerprint: string): void;
  /** The fingerprint of the master key a person said they saved (issue #659); undefined: none. */
  masterKeySaved(): string | undefined;
  setMasterKeySaved(fingerprint: string): void;
  /** The last master key rotation (issue #659): the fingerprint of the key it replaced, and when; undefined: none. */
  masterKeyRotation(): MasterKeyRotation | undefined;
  setMasterKeyRotation(rotation: MasterKeyRotation): void;
  /** Remote access (issue #880): the tunnel on or off and its domain; undefined: never set. */
  getRemoteAccess(): RemoteAccessSettings | undefined;
  setRemoteAccess(settings: RemoteAccessSettings): void;
  /** The host link base (issue #712): the address people open, an origin; empty: never set, the default applies. */
  getHostLinkBase(): string;
  setHostLinkBase(base: string): void;
  /** The hosts the admin allowed beyond the LAN names (issue #1024); empty: never set. */
  getAllowedHosts(): string[];
  setAllowedHosts(hosts: readonly string[]): void;
  /** The source email match (issue #1380): an account connected from Sources must have its person's email verified; never set: on. */
  getSourceEmailMatch(): boolean;
  setSourceEmailMatch(on: boolean): void;
  /** Infra applies (issue #1722): whether the vault mints a write, sync or apply for an approved plan, and steps apply; never set: on. */
  getInfraApplies(): boolean;
  setInfraApplies(on: boolean): void;
  /** The telemetry setting (issue #1486): the OTLP export the admin set; never set: off. */
  getTelemetry(): TelemetrySettings;
  setTelemetry(settings: TelemetrySettings): void;
  /** The cloud link (issue #467): this install linked to a hopper.io account; undefined: not linked. */
  getCloudLink(): CloudLinkSettings | undefined;
  setCloudLink(link: CloudLinkSettings): void;
  /** Deletes the link record, and nothing else. */
  removeCloudLink(): void;
  /** The open registration code of the cloud link (issue #465), hashed; undefined: none. */
  getCloudRegistrationCode(): CloudRegistrationCode | undefined;
  setCloudRegistrationCode(code: CloudRegistrationCode): void;
  removeCloudRegistrationCode(): void;
  /** The instance's display name (issue #465): what the hopper's admin calls this hopper; empty: never set, or cleared. */
  getDisplayName(): string;
  setDisplayName(name: string): void;
}

/** A master key rotation (issue #659): the replaced key's fingerprint (never the key), and when. */
export interface MasterKeyRotation {
  from: string;
  at: string;
}
