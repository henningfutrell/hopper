import type { SettingsRepository } from '../domain/ports.ts';
import type { RouterMode } from '../domain/types.ts';
import type { StoreContext } from './context.ts';

export function createSettingsRepository(c: StoreContext): SettingsRepository {
  return {
    getRouterMode() {
      const r = c.db.get("SELECT value FROM settings WHERE key = 'routerMode'");
      return r ? (r.value as RouterMode) : undefined;
    },
    setRouterMode(mode) {
      c.db.run("INSERT INTO settings (key, value) VALUES ('routerMode', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", mode);
    },
  };
}
