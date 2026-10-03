import type { SettingsRepository } from '../domain/ports.ts';
import type { JevMode } from '../domain/types.ts';
import type { StoreContext } from './context.ts';

export function createSettingsRepository(c: StoreContext): SettingsRepository {
  return {
    getJevMode() {
      const r = c.db.prepare("SELECT value FROM settings WHERE key = 'jevMode'").get();
      return r ? (r.value as JevMode) : undefined;
    },
    setJevMode(mode) {
      c.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('jevMode', ?)").run(mode);
    },
  };
}
