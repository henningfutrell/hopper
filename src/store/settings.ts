import { randomBytes } from 'node:crypto';
import type { RateLimiterSettings } from '../domain/github-rate-limit.ts';
import { remoteAccessRecord, type RemoteAccessSettings } from '../domain/remote-access.ts';
import type { IntakeActorSettings } from '../domain/intake-origin.ts'; import type { IntakeAutoApproval } from '../domain/intake-auto-approve.ts'; import type { IntakeDeclineDefaults } from '../domain/intake-decline.ts'; import type { IntakeStrictness } from '../domain/intake-strictness.ts';
import type { IntakeMigration } from '../domain/intake.ts';
import type { InstanceSettingsRepository, UserSettingsRepository } from '../domain/ports.ts';
import type { InfraPlanSettings } from '../domain/infra-plans.ts'; import type { DeliverySettings } from '../domain/delivery-settings.ts';
import type { AutoAnswerSettings, BlastRadiusSettings, ComponentWatcherSettings, ConnectedAccountKey, ContributionSettings, ShrinkGuardSettings, DiscoveryRecord, FailureSettings, GitHubWatchSettings, LaneDismissals, LaneTuningSettings, LoginExpiryAction, MinorDecisionSettings, NamedCause, PhaseShiftSettings, PluginInstall, PluginStoreSource, PriorityLaneSettings, QueueGate, ReviewKind, ReviewSettings, ThreadAskSettings, TldrSettings, UpdateChannel, UpdateSettings, UsageGraphView, UsageLimitPair, YoloModeSettings, LandingBatchSettings } from '../domain/types.ts';
import type { TokenBudgetSettings } from '../domain/token-budget.ts'; import type { ModelRoutingSettings } from '../domain/model-routing.ts';
import { graphStepFor, LOGIN_EXPIRY_ACTIONS, PRESET_MS, UPDATE_CHANNELS } from '../domain/types.ts';
import type { StoreContext } from './context.ts';
import type { MasterKeyRotation } from '../domain/settings-store.ts'; import { sandboxSettings } from './sandbox-settings.ts'; import { memoryAlertSettings } from './memory-alert-settings.ts'; import { machineDrainSettings } from './machine-drain-settings.ts'; import { diskBudgetSettings } from './disk-budget-settings.ts'; import { diskDefaultsSettings } from './disk-defaults-settings.ts'; import { pushRequirementSettings } from './push-requirement-settings.ts'; import { headerBadgeSettings } from './header-badges-settings.ts'; import { taggedSettings } from './tagged-settings.ts'; import { gitlabAccountSettings } from './gitlab-account-settings.ts'; import { preemptionSettings } from './preemption-settings.ts'; import { cloudLinkSettings } from './cloud-link-settings.ts'; import { telemetrySettings } from './telemetry-settings.ts'; import { newRepositorySettings } from './new-repository-settings.ts'; import { publicBugReportSettings } from './public-bug-report-settings.ts'; import { jobEgressSettings } from './job-egress-settings.ts'; import { completionReviewSettings } from './completion-review-settings.ts'; import { gradeSettings } from './grade-settings.ts';

/** Each review section's settings row (issues #537, #543). */
const REVIEW_SETTINGS_KEYS: Readonly<Record<ReviewKind, string>> = { proposal: 'proposalSettings', research: 'researchSettings' };

/** `settings` rows by key, in whichever schema the context's connection reads. */
function keyValues(c: StoreContext) {
  return {
    read: (key: string): string | undefined => {
      const r = c.db.get('SELECT value FROM settings WHERE key = ?', key);
      return r ? (r.value as string) : undefined;
    },
    write: (key: string, value: string): void => {
      c.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
    }, remove: (key: string): void => { c.db.run('DELETE FROM settings WHERE key = ?', key); },
  };
}

/** The settings key of a connected account's job repositories (issue #321), by the account's key (issue #1448). */
export const jobRepositoriesKey = (key: ConnectedAccountKey): string => `jobRepositories:${key}`;

/** A user's settings: the queue gate, the hopper's own ssh key (issue #293), its link key (issue #308), the job repositories (issue #321), the usage graph view and history retention (issue #385), the usage limits (issue #522), the memory alert (issue #868), the disk budget (issue #1120), the disk defaults (issue #2494), the default push requirements (issue #2555), the header badges (issue #1181). */
export function createUserSettingsRepository(c: StoreContext): UserSettingsRepository {
  const { read, write } = keyValues(c);
  return {
    ...sandboxSettings(read, write), // the read policy (issue #716) and the sandbox approval toggles (issue #991)
    ...memoryAlertSettings(read, write), ...machineDrainSettings(read, write), ...diskBudgetSettings(read, write), ...diskDefaultsSettings(read, write), ...pushRequirementSettings(read, write), ...headerBadgeSettings(read, write), ...taggedSettings(read, write), ...preemptionSettings(read, write), ...gitlabAccountSettings(read, write), ...newRepositorySettings(read, write), ...publicBugReportSettings(read, write), ...jobEgressSettings(read, write), ...completionReviewSettings(read, write), ...gradeSettings(read, write), // the grade settings (issue #2845), completion reviews (issue #2846), job egress (issue #2849), public bug reports (issue #2818), new repositories (issue #2795), the GitLab account (issue #1448 part 2), the memory alert (issue #868), the disk budget (issue #1120), the header badges (issue #1181), tagged items (issue #1141), preemption (issue #1525)
    getQueueGate() {
      const text = read('queueGate');
      return text === undefined ? undefined : JSON.parse(text) as QueueGate;
    },
    setQueueGate(gate) {
      write('queueGate', JSON.stringify({ mode: gate.mode, autoAcceptPerHour: gate.autoAcceptPerHour }));
    },
    getSshKey() {
      const text = read('sshKey');
      return text === undefined ? undefined : JSON.parse(text) as { privateKey: string; publicKey: string };
    },
    setSshKey(key) {
      write('sshKey', JSON.stringify({ privateKey: key.privateKey, publicKey: key.publicKey }));
    },
    getLinkKey() {
      const text = read('linkKey');
      return text === undefined ? undefined : JSON.parse(text) as { privateKey: string; publicKey: string };
    },
    setLinkKey(key) {
      write('linkKey', JSON.stringify({ privateKey: key.privateKey, publicKey: key.publicKey }));
    },
    getJobRepositories(provider) {
      const text = read(jobRepositoriesKey(provider));
      return text === undefined ? [] : JSON.parse(text) as string[];
    },
    setJobRepositories(provider, repositories) {
      write(jobRepositoriesKey(provider), JSON.stringify(repositories));
    },
    getUsageGraphView() {
      const text = read('usageGraphView');
      return text === undefined ? undefined : { range: (JSON.parse(text) as UsageGraphView).range };
    },
    // The step the graph step follows (issue #502) is kept beside the range for the build before, which reads it.
    setUsageGraphView(view) {
      const r = view.range;
      const span = 'preset' in r ? PRESET_MS[r.preset] : Date.parse(r.to) - Date.parse(r.from);
      write('usageGraphView', JSON.stringify({ range: 'preset' in r ? { preset: r.preset } : { from: r.from, to: r.to }, step: graphStepFor(span) }));
    },
    getHistoryRetentionDays() {
      const text = read('historyRetentionDays');
      return text === undefined ? undefined : Number(text);
    },
    setHistoryRetentionDays(days) {
      write('historyRetentionDays', String(days));
    },
    getUsageLimits() {
      const text = read('usageLimits');
      if (text === undefined) return undefined;
      // Stored before issue #2091 with no soft lanes: the default applies.
      const { soft, hard, softLanes } = JSON.parse(text) as UsageLimitPair;
      return { soft, hard, ...(softLanes === undefined ? {} : { softLanes }) };
    },
    setUsageLimits(limits) {
      write('usageLimits', JSON.stringify({ soft: limits.soft, hard: limits.hard, ...(limits.softLanes === undefined ? {} : { softLanes: limits.softLanes }) }));
    },
    getLaneTuning() {
      const text = read('laneTuning');
      return text === undefined ? {} : JSON.parse(text) as LaneTuningSettings;
    },
    setLaneTuning(settings) {
      write('laneTuning', JSON.stringify(Object.fromEntries(Object.entries(settings).sort(([a], [b]) => a.localeCompare(b))
        .map(([id, t]) => [id, { autoTune: t.autoTune, minLanes: t.minLanes, maxLanes: t.maxLanes }]))));
    },
    getLaneDismissals() {
      const text = read('laneDismissals');
      return text === undefined ? {} : JSON.parse(text) as LaneDismissals;
    },
    setLaneDismissals(dismissals) {
      write('laneDismissals', JSON.stringify(dismissals));
    },
    getPriorityLanes() {
      const text = read('priorityLanes');
      return text === undefined ? undefined : JSON.parse(text) as PriorityLaneSettings;
    },
    setPriorityLanes(s) {
      write('priorityLanes', JSON.stringify({
        highPriority: s.highPriority, count: s.count, whenIdle: s.whenIdle, windowDays: s.windowDays, minRuns: s.minRuns, ...(s.manual ? { manual: s.manual } : {}),
      }));
    },
    getPriorityLaneChoice() {
      const text = read('priorityLaneChoice');
      return text === undefined ? undefined : JSON.parse(text) as string[];
    },
    setPriorityLaneChoice(lanes) {
      write('priorityLaneChoice', JSON.stringify([...lanes]));
    },
    getBlastRadius() {
      const text = read('blastRadius');
      return text === undefined ? undefined : JSON.parse(text) as BlastRadiusSettings;
    },
    setBlastRadius(s) {
      write('blastRadius', JSON.stringify({
        gateAt: s.gateAt,
        pass: { labels: s.pass.labels, repos: s.pass.repos, ...(s.pass.minPriority !== undefined ? { minPriority: s.pass.minPriority } : {}) },
        rules: { prodPatterns: s.rules.prodPatterns, prodAccounts: s.rules.prodAccounts, unconfirmed: s.rules.unconfirmed },
        actors: s.actors.map((a) => ({ machineId: a.machineId, purpose: a.purpose, expected: a.expected })),
        everyMinutes: s.everyMinutes,
      }));
    },
    getDiscovery(machineId) {
      const text = read(`discovery:${machineId}`);
      return text === undefined ? undefined : JSON.parse(text) as DiscoveryRecord;
    },
    setDiscovery(record) {
      write(`discovery:${record.machineId}`, JSON.stringify(record));
    },
    claimHolder() {
      const kept = read('claimHolder');
      if (kept !== undefined) return kept;
      const made = randomBytes(6).toString('hex');
      c.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', 'claimHolder', made);
      return read('claimHolder')!;
    },
    getIntakeMigration(source) {
      const text = read(`intakeMigration:${source}`);
      return text === undefined ? undefined : JSON.parse(text) as IntakeMigration;
    },
    setIntakeMigration(source, migration) {
      write(`intakeMigration:${source}`, JSON.stringify({ at: migration.at, changes: migration.changes.map((x) => ({ key: x.key, change: x.change })) }));
    },
    getLoginExpiry() {
      const text = read('loginExpiry');
      return text !== undefined && (LOGIN_EXPIRY_ACTIONS as readonly string[]).includes(text) ? text as LoginExpiryAction : undefined;
    },
    setLoginExpiry(action) {
      write('loginExpiry', action);
    },
    getLoginWarnSec() {
      const n = Number(read('loginWarnSec'));
      return Number.isInteger(n) && n > 0 ? n : undefined;
    },
    setLoginWarnSec(seconds) {
      write('loginWarnSec', String(seconds));
    },
    getReviewSettings(kind) {
      const text = read(REVIEW_SETTINGS_KEYS[kind]);
      return text === undefined ? undefined : JSON.parse(text) as ReviewSettings;
    },
    setReviewSettings(kind, settings) {
      write(REVIEW_SETTINGS_KEYS[kind], JSON.stringify({ reviewers: [...settings.reviewers], signOff: settings.signOff, levelRevisions: settings.levelRevisions, ...(settings.autoContinue !== undefined ? { autoContinue: settings.autoContinue } : {}) }));
    },
    getPhaseShifts() {
      const text = read('phaseShifts');
      if (text === undefined) return undefined;
      // A record from before issue #2335 has `forkParent`: no longer read.
      const { defaultMode, levels } = JSON.parse(text) as PhaseShiftSettings;
      return { defaultMode, levels };
    },
    setPhaseShifts(settings) {
      write('phaseShifts', JSON.stringify({ defaultMode: settings.defaultMode, levels: [...settings.levels] }));
    },
    getAutoAnswer() {
      const text = read('autoAnswer');
      return text === undefined ? undefined : JSON.parse(text) as AutoAnswerSettings;
    },
    setAutoAnswer(settings) {
      // `holdHighPriority` (issue #679): absent in a record from before it, read as off; the build before ignores it.
      write('autoAnswer', JSON.stringify({ enabled: settings.enabled, threshold: settings.threshold, ...(settings.holdHighPriority === undefined ? {} : { holdHighPriority: settings.holdHighPriority }) }));
    },
    getTokenBudget: () => { const text = read('tokenBudget'); return text === undefined ? undefined : JSON.parse(text) as Partial<TokenBudgetSettings>; },
    setTokenBudget: (s) => write('tokenBudget', JSON.stringify({
      jobTokens: s.jobTokens, jobCostUsd: s.jobCostUsd, dayTokens: s.dayTokens, dayCostUsd: s.dayCostUsd, repoDayTokens: s.repoDayTokens, repoDayCostUsd: s.repoDayCostUsd })),
    getModelRouting: () => { const t = read('modelRouting'); return t === undefined ? undefined : JSON.parse(t) as Partial<ModelRoutingSettings>; }, setModelRouting: (s) => write('modelRouting', JSON.stringify({ on: s.on, executors: s.executors, cheap: s.cheap, strong: s.strong, rules: s.rules, repos: s.repos, escalate: s.escalate, tune: s.tune })),
    getThreadAsk: () => { const text = read('threadAsk'); return text === undefined ? undefined : JSON.parse(text) as ThreadAskSettings; },
    setThreadAsk: (s) => write('threadAsk', JSON.stringify({ ownRepos: s.ownRepos, otherRepos: s.otherRepos })),
    getTldr() { const text = read('tldr'); return text === undefined ? undefined : JSON.parse(text) as TldrSettings; }, setTldr(settings) { write('tldr', JSON.stringify({ enabled: settings.enabled })); },
    getGitHubWatch: () => { const t = read('githubWatch'); return t === undefined ? undefined : JSON.parse(t) as GitHubWatchSettings; },
    setGitHubWatch: (s) => write('githubWatch', JSON.stringify({ intervalSeconds: s.intervalSeconds })),
    getComponentWatchers: () => { const t = read('componentWatchers'); return t === undefined ? undefined : JSON.parse(t) as ComponentWatcherSettings; }, setComponentWatchers: (s) => write('componentWatchers', JSON.stringify({ fileIssues: s.fileIssues })),
    getYoloMode() {
      const text = read('yoloMode');
      return text === undefined ? undefined : JSON.parse(text) as YoloModeSettings;
    },
    setYoloMode(settings) {
      write('yoloMode', JSON.stringify({ on: settings.on, repos: settings.repos, ...(settings.changeKinds ? { changeKinds: settings.changeKinds } : {}), ...(settings.push?.length ? { push: settings.push } : {}) }));
    },
    getLandingBatches() { const text = read('landingBatches'); return text === undefined ? undefined : JSON.parse(text) as LandingBatchSettings; }, setLandingBatches(settings) { write('landingBatches', JSON.stringify({ repos: settings.repos })); },
    getDeliverySettings() { const text = read('deliverySettings'); return text === undefined ? undefined : JSON.parse(text) as DeliverySettings; }, setDeliverySettings(settings) { write('deliverySettings', JSON.stringify({ repos: settings.repos })); },
    getContribution() { const text = read('contribution'); return text === undefined ? undefined : JSON.parse(text) as ContributionSettings; }, setContribution(settings) { write('contribution', JSON.stringify({ on: settings.on })); }, getShrinkGuard() { const text = read('shrinkGuard'); return text === undefined ? undefined : JSON.parse(text) as ShrinkGuardSettings; }, setShrinkGuard(settings) { write('shrinkGuard', JSON.stringify({ percent: settings.percent })); },
    getInfraPlans() { const text = read('infraPlans'); return text === undefined ? undefined : JSON.parse(text) as InfraPlanSettings; },
    setInfraPlans(settings) { write('infraPlans', JSON.stringify({ autoApprove: settings.autoApprove })); }, getInfraWatchers() { const text = read('infraWatchers'); return text === undefined ? undefined : JSON.parse(text) as Record<string, string[]>; }, setInfraWatchers(watchers) { write('infraWatchers', JSON.stringify(watchers)); },
    getIntakeActors() { const text = read('intakeActors'); return text === undefined ? undefined : JSON.parse(text) as IntakeActorSettings; },
    // `actors` stays the logins (issue #930): the build before ids reads them; `accounts` holds each one's GitHub user id.
    setIntakeActors: (s) => write('intakeActors', JSON.stringify({ actors: s.actors, ...(s.accounts ? { accounts: s.accounts.map((a) => ({ id: a.id, login: a.login, type: a.type, ...(a.avatarUrl ? { avatarUrl: a.avatarUrl } : {}) })) } : {}) })),
    getIntakeAutoApproval() { const text = read('intakeAutoApproval'); return text === undefined ? undefined : JSON.parse(text) as IntakeAutoApproval; }, setIntakeAutoApproval: (s) => write('intakeAutoApproval', JSON.stringify({ on: s.on, apps: s.apps })), getIntakeDecline() { const text = read('intakeDecline'); return text === undefined ? undefined : JSON.parse(text) as IntakeDeclineDefaults; }, setIntakeDecline: (s) => write('intakeDecline', JSON.stringify({ request: s.request, reopened: s.reopened })), getIntakeStrictness() { const text = read('intakeStrictness'); return text === undefined ? undefined : JSON.parse(text) as IntakeStrictness; }, setIntakeStrictness: (s) => write('intakeStrictness', JSON.stringify({ default: s.default, sources: s.sources, repos: s.repos })),
    getRepoChecksDismissed() {
      const text = read('repoChecksDismissed');
      return text === undefined ? [] : JSON.parse(text) as string[];
    },
    setRepoChecksDismissed(repos) {
      write('repoChecksDismissed', JSON.stringify([...repos]));
    },
    getBackfills() {
      const text = read('backfills');
      return text === undefined ? {} : JSON.parse(text) as Record<string, string>;
    },
    setBackfills(done) {
      write('backfills', JSON.stringify(done));
    },
    getFailureSettings() {
      const text = read('failureSettings');
      return text === undefined ? undefined : JSON.parse(text) as FailureSettings;
    },
    setFailureSettings(settings) {
      write('failureSettings', JSON.stringify(settings));
    },
    getMinorDecisionSettings() {
      const text = read('minorDecisions');
      return text === undefined ? {} : JSON.parse(text) as Partial<MinorDecisionSettings>;
    },
    setMinorDecisionSettings(settings) {
      write('minorDecisions', JSON.stringify(settings));
    },
    getNamedCauses() {
      const text = read('failureCauses');
      return text === undefined ? [] : JSON.parse(text) as NamedCause[];
    },
    setNamedCauses(causes) {
      write('failureCauses', JSON.stringify(causes.map((c) => ({ signature: c.signature, name: c.name, description: c.description, decision: c.decision }))));
    },
  };
}

/** The update settings that are on or off, and their keys: auto-update, and taking stable releases early (issue #1073 part 5). */
const UPDATE_SWITCHES = [['autoUpdate', 'autoUpdate'], ['updateCanary', 'canary']] as const;

/** The instance's settings: self-update, the shared rate limiter (issue #436), the plugin store (issue #445), the store installs, the cloud link (issue #467) and telemetry (issue #1486). */
export function createInstanceSettingsRepository(c: StoreContext): InstanceSettingsRepository {
  const { read, write, remove } = keyValues(c);
  return {
    ...cloudLinkSettings(read, write, remove), ...telemetrySettings(read, write), getUpdateSettings() {
      const out: Partial<UpdateSettings> = {};
      const channel = read('updateChannel');
      if (channel && (UPDATE_CHANNELS as readonly string[]).includes(channel)) out.channel = channel as UpdateChannel;
      for (const [key, field] of UPDATE_SWITCHES) { const v = read(key); if (v !== undefined) out[field] = v === 'true'; }
      return out;
    },
    setUpdateSettings(patch) {
      if (patch.channel !== undefined) write('updateChannel', patch.channel);
      for (const [key, field] of UPDATE_SWITCHES) if (patch[field] !== undefined) write(key, String(patch[field]));
    },
    getPluginInstalls() {
      const text = read('pluginInstalls');
      return text === undefined ? [] : JSON.parse(text) as PluginInstall[];
    },
    setPluginInstalls(installs) {
      write('pluginInstalls', JSON.stringify([...installs].sort((a, b) => a.id.localeCompare(b.id))));
    },
    getGitHubRateLimiter: () => JSON.parse(read('githubRateLimiter') ?? '{}') as Partial<RateLimiterSettings>,
    setGitHubRateLimiter: (s) => write('githubRateLimiter', JSON.stringify({ slowBelowPercent: s.slowBelowPercent, reserve: s.reserve, batchSize: s.batchSize, intakeReserve: s.intakeReserve, intakeSyncMinutes: s.intakeSyncMinutes, prCycleMinutes: s.prCycleMinutes })),
    getPluginStoreSource() {
      const text = read('pluginStore');
      return text === undefined ? undefined : JSON.parse(text) as PluginStoreSource;
    },
    setPluginStoreSource(source) {
      write('pluginStore', JSON.stringify(source.kind === 'repo' ? { kind: 'repo', repo: source.repo } : { kind: source.kind }));
    },
    instanceId() {
      return c.tx(() => {
        c.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', 'instanceId', randomBytes(8).toString('hex'));
        return read('instanceId')!;
      });
    },
    masterKeyFingerprint: () => read('masterKeyFingerprint'),
    setMasterKeyFingerprint: (fingerprint) => write('masterKeyFingerprint', fingerprint),
    masterKeySaved: () => read('masterKeySaved'),
    setMasterKeySaved: (fingerprint) => write('masterKeySaved', fingerprint),
    masterKeyRotation() {
      const text = read('masterKeyRotation');
      return text === undefined ? undefined : JSON.parse(text) as MasterKeyRotation;
    },
    setMasterKeyRotation: (rotation) => write('masterKeyRotation', JSON.stringify({ from: rotation.from, at: rotation.at })),
    getRemoteAccess() { const text = read('remoteAccess'); return text === undefined ? undefined : JSON.parse(text) as RemoteAccessSettings; },
    setRemoteAccess: (s) => write('remoteAccess', JSON.stringify(remoteAccessRecord(s))),
    getHostLinkBase: () => read('hostLinkBase') ?? '', setHostLinkBase: (base) => write('hostLinkBase', base),
    getAllowedHosts() { const text = read('allowedHosts'); return text === undefined ? [] : JSON.parse(text) as string[]; },
    setAllowedHosts: (hosts) => write('allowedHosts', JSON.stringify([...hosts])), getSourceEmailMatch: () => read('sourceEmailMatch') !== 'off', setSourceEmailMatch: (on) => write('sourceEmailMatch', on ? 'on' : 'off'), getInfraApplies: () => read('infraApplies') !== 'off', setInfraApplies: (on) => write('infraApplies', on ? 'on' : 'off'), getDisplayName: () => read('displayName') ?? '', setDisplayName: (name) => write('displayName', name),
  };
}
