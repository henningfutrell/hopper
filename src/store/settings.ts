import { randomBytes } from 'node:crypto';
import type { IntakeMigration } from '../domain/intake.ts';
import type { InstanceSettingsRepository, UserSettingsRepository } from '../domain/ports.ts';
import type { ConnectedAccountProvider, LoginExpiryAction, PluginInstall, PluginStoreSource, QueueGate, UpdateChannel, UpdateSettings, UsageGraphView } from '../domain/types.ts';
import { LOGIN_EXPIRY_ACTIONS, UPDATE_CHANNELS } from '../domain/types.ts';
import type { StoreContext } from './context.ts';

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

/** A user's settings: the queue gate, the hopper's own ssh key (issue #293), its link key (issue #308), the job repositories (issue #321), the usage graph view and history retention (issue #385). */
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
      return text === undefined ? undefined : JSON.parse(text) as UsageGraphView;
    },
    setUsageGraphView(view) {
      write('usageGraphView', JSON.stringify({ range: 'preset' in view.range ? { preset: view.range.preset } : { from: view.range.from, to: view.range.to }, step: view.step }));
    },
    getHistoryRetentionDays() {
      const text = read('historyRetentionDays');
      return text === undefined ? undefined : Number(text);
    },
    setHistoryRetentionDays(days) {
      write('historyRetentionDays', String(days));
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
  };
}
