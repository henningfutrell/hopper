import type { SettingsRepository } from '../domain/ports.ts';
import type { RouterMode, UpdateChannel, UpdateSettings } from '../domain/types.ts';
import { UPDATE_CHANNELS } from '../domain/types.ts';
import type { StoreContext } from './context.ts';

export function createSettingsRepository(c: StoreContext): SettingsRepository {
  const read = (key: string): string | undefined => {
    const r = c.db.get('SELECT value FROM settings WHERE key = ?', key);
    return r ? (r.value as string) : undefined;
  };
  const write = (key: string, value: string): void => {
    c.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
  };
  return {
    getRouterMode() {
      return read('routerMode') as RouterMode | undefined;
    },
    setRouterMode(mode) {
      write('routerMode', mode);
    },
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
  };
}
