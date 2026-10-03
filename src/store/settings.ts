import type { SettingsRepository } from '../domain/ports.ts';
import type { RouterMode } from '../domain/types.ts';
import type { StoreContext } from './context.ts';

export function createSettingsRepository(c: StoreContext): SettingsRepository {
  return {
    getRouterMode() {
      const r = c.db.prepare("SELECT value FROM settings WHERE key = 'routerMode'").get();
      return r ? (r.value as RouterMode) : undefined;
    },
    setRouterMode(mode) {
      c.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('routerMode', ?)").run(mode);
    },
  };
}
