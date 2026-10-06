import type { InstanceSettingsRepository, UserSettingsRepository } from '../domain/ports.ts';
import type { PluginInstall, QueueGate, UpdateChannel, UpdateSettings } from '../domain/types.ts';
import { UPDATE_CHANNELS } from '../domain/types.ts';
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

/** A user's settings: the queue gate. */
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
  };
}

/** The instance's settings: self-update and the store installs. */
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
  };
}
