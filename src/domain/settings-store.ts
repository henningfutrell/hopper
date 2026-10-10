// The settings repositories' ports, apart from store.ts for its size (re-exported there): a user's settings and the
// instance's. Each value is absent until set.

import type { IntakeMigration } from './intake.ts';
import type {
  AutoAnswerSettings, BlastRadiusSettings, ConnectedAccountProvider, LaneId, DiscoveryRecord, FailureSettings, LoginExpiryAction, MinorDecisionSettings, NamedCause, PhaseShiftSettings,
  PluginInstall, PluginStoreSource, PriorityLaneSettings, QueueGate, ReviewKind, ReviewSettings, UpdateSettings, UsageGraphView, UsageLimitPair, YoloModeSettings,
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
  /** The repositories a connected account's jobs may use (issue #321); empty: none chosen. */
  getJobRepositories(provider: ConnectedAccountProvider): string[];
  setJobRepositories(provider: ConnectedAccountProvider, repositories: readonly string[]): void;
  /** The usage graph's range and step the user chose (issue #385); absent: never chosen. */
  getUsageGraphView(): UsageGraphView | undefined;
  setUsageGraphView(view: UsageGraphView): void;
  /** How many days usage samples are kept (issue #385); absent: never chosen. */
  getHistoryRetentionDays(): number | undefined;
  setHistoryRetentionDays(days: number): void;
  /** The usage limits the user set (issue #522); absent: never set, the defaults apply. */
  getUsageLimits(): UsageLimitPair | undefined;
  setUsageLimits(limits: UsageLimitPair): void;
  /** The priority lane settings the user saved (issue #535); absent: never saved, the defaults apply. */
  getPriorityLanes(): PriorityLaneSettings | undefined;
  setPriorityLanes(settings: PriorityLaneSettings): void;
  /** The priority lanes last chosen (issue #535), so a restart keeps them and their hysteresis; absent: none yet. */
  getPriorityLaneChoice(): LaneId[] | undefined;
  setPriorityLaneChoice(lanes: readonly LaneId[]): void;
  /** The blast-radius settings the user saved (issue #542); absent: never saved, the defaults apply. */
  getBlastRadius(): BlastRadiusSettings | undefined;
  setBlastRadius(settings: BlastRadiusSettings): void;
  /** A machine's last discovery (issue #542); absent: never discovered. */
  getDiscovery(machineId: string): DiscoveryRecord | undefined;
  setDiscovery(record: DiscoveryRecord): void;
  /** The user's claim holder id (issue #440): made, random, the first time it is asked, then kept. */
  claimHolder(): string;
  /** A job source's intake migration (issue #440), by its instance name; absent: not run yet. */
  getIntakeMigration(source: string): IntakeMigration | undefined;
  setIntakeMigration(source: string, migration: IntakeMigration): void;
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
  /** Yolo mode (issue #579): whether jobs may merge their own pull requests; absent: never set (off). */
  getYoloMode(): YoloModeSettings | undefined;
  setYoloMode(settings: YoloModeSettings): void;
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
  /** The plugin store setting (issue #445); undefined: never set. */
  getPluginStoreSource(): PluginStoreSource | undefined;
  setPluginStoreSource(source: PluginStoreSource): void;
  /** This hopper's id (issue #603), made at its first ask and kept: the label of the sandbox boxes it launches. */
  instanceId(): string;
}
