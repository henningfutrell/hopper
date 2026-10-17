// Where the hopper's app is installed, as last read (issue #1250, tenant migration 66): one row per connected account, by its key (issue #1448), the read as
// JSON, with its answers' ETags. Derived data: a lost row is read again from GitHub at the next Refresh or schedule.
import type { AppInstallationsRead, AppInstallationsReadRepository } from '../domain/types.ts';
import { parse, type StoreContext } from './context.ts';

export const APP_INSTALLATIONS_TABLE = 'CREATE TABLE app_installations (provider TEXT PRIMARY KEY, body TEXT NOT NULL)';

export function createAppInstallationsReadRepository(c: StoreContext): AppInstallationsReadRepository {
  return {
    get(provider) {
      const r = c.db.get('SELECT body FROM app_installations WHERE provider = ?', provider);
      return r ? parse<AppInstallationsRead>(r.body) : undefined;
    },
    put(read, key = read.provider) {
      c.db.run('INSERT INTO app_installations (provider, body) VALUES (?, ?) ON CONFLICT (provider) DO UPDATE SET body = excluded.body', key, JSON.stringify(read));
    },
    remove(provider) {
      c.db.run('DELETE FROM app_installations WHERE provider = ?', provider);
    },
  };
}
