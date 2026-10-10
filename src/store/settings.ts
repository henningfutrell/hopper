import { randomBytes } from 'node:crypto';
import type { IntakeMigration } from '../domain/intake.ts';
import type { InstanceSettingsRepository, UserSettingsRepository } from '../domain/ports.ts';
import type { AutoAnswerSettings, AutoParkSettings, BlastRadiusSettings, ConnectedAccountProvider, DiscoveryRecord, FailureSettings, MinorDecisionSettings, PriorityLaneSettings, NamedCause, LoginExpiryAction, PluginInstall, ReviewKind, ReviewSettings, PluginStoreSource, QueueGate, UpdateChannel, UpdateSettings, UsageGraphView, UsageLimitPair, PhaseShiftSettings, TldrSettings, YoloModeSettings } from '../domain/types.ts';
import { graphStepFor, LOGIN_EXPIRY_ACTIONS, PRESET_MS, UPDATE_CHANNELS } from '../domain/types.ts';
import type { StoreContext } from './context.ts';

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
    },
  };
}

/** The settings key of a connected account's job repositories (issue #321). */
export const jobRepositoriesKey = (provider: ConnectedAccountProvider): string => `jobRepositories:${provider}`;

/** A user's settings: the queue gate, the hopper's own ssh key (issue #293), its link key (issue #308), the job repositories (issue #321), the usage graph view and history retention (issue #385), the usage limits (issue #522). */
export function createUserSettingsRepository(c: StoreContext): UserSettingsRepository {
  const { read, write } = keyValues(c);
  return {
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
      const { soft, hard } = JSON.parse(text) as UsageLimitPair;
      return { soft, hard };
    },
    setUsageLimits(limits) {
      write('usageLimits', JSON.stringify({ soft: limits.soft, hard: limits.hard }));
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
      write(REVIEW_SETTINGS_KEYS[kind], JSON.stringify({ reviewers: [...settings.reviewers], signOff: settings.signOff, levelRevisions: settings.levelRevisions }));
    },
    getPhaseShifts() {
      const text = read('phaseShifts');
      return text === undefined ? undefined : JSON.parse(text) as PhaseShiftSettings;
    },
    setPhaseShifts(settings) {
      write('phaseShifts', JSON.stringify({ defaultMode: settings.defaultMode, forkParent: settings.forkParent, levels: [...settings.levels] }));
    },
    getAutoAnswer() {
      const text = read('autoAnswer');
      return text === undefined ? undefined : JSON.parse(text) as AutoAnswerSettings;
    },
    setAutoAnswer(settings) {
      write('autoAnswer', JSON.stringify({ enabled: settings.enabled, threshold: settings.threshold }));
    },
    getAutoPark() {
      const text = read('autoPark');
      return text === undefined ? undefined : JSON.parse(text) as AutoParkSettings;
    },
    setAutoPark(settings) {
      write('autoPark', JSON.stringify({ minutes: settings.minutes, highPriorityMinutes: settings.highPriorityMinutes }));
    },
    getTldr() {
      const text = read('tldr');
      return text === undefined ? undefined : JSON.parse(text) as TldrSettings;
    },
    setTldr(settings) {
      write('tldr', JSON.stringify({ enabled: settings.enabled }));
    },
    getYoloMode() {
      const text = read('yoloMode');
      return text === undefined ? undefined : JSON.parse(text) as YoloModeSettings;
    },
    setYoloMode(settings) {
      write('yoloMode', JSON.stringify({ on: settings.on, repos: settings.repos }));
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

/** The instance's settings: self-update, the plugin store (issue #445) and the store installs. */
export function createInstanceSettingsRepository(c: StoreContext): InstanceSettingsRepository {
  const { read, write } = keyValues(c);
  return {
    getUpdateSettings() {
      const out: Partial<UpdateSettings> = {};
      const channel = read('updateChannel');
      if (channel && (UPDATE_CHANNELS as readonly string[]).includes(channel)) out.channel = channel as UpdateChannel;
      const auto = read('autoUpdate');
      if (auto !== undefined) out.autoUpdate = auto === 'true';
      return out;
    },
    setUpdateSettings(patch) {
      if (patch.channel !== undefined) write('updateChannel', patch.channel);
      if (patch.autoUpdate !== undefined) write('autoUpdate', String(patch.autoUpdate));
    },
    getPluginInstalls() {
      const text = read('pluginInstalls');
      return text === undefined ? [] : JSON.parse(text) as PluginInstall[];
    },
    setPluginInstalls(installs) {
      write('pluginInstalls', JSON.stringify([...installs].sort((a, b) => a.id.localeCompare(b.id))));
    },
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
  };
}
