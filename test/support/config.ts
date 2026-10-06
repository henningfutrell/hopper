// Config records for a unit test of a part that reads them (the plugin host, an editor): the real
// store's, in a temp database, removed after each test.
import { afterEach } from 'vitest';
import type { ConfigRecords, UserConfigName, UserStore } from '../../src/domain/ports.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { testDatabaseUrl } from './database.ts';

export interface TempConfig extends ConfigRecords {
  /** Replace a record whatever its version. */
  set(name: UserConfigName, value: unknown): void;
  store: UserStore;
}

/** Call at module level: `const config = useTempConfig();` then `config()` in a test for a fresh, empty set. */
export function useTempConfig(): () => TempConfig {
  const open: UserStore[] = [];
  afterEach(() => {
    for (const store of open.splice(0)) store.close();
  });
  return () => {
    const instance = openInstanceStore({ url: testDatabaseUrl(), clock: { now: () => new Date() } });
    const owner = instance.userStore(instance.users.owner());
    const store: UserStore = { ...owner, close: () => { owner.close(); instance.close(); } };
    open.push(store);
    const c = store.config;
    return {
      store,
      read: (n) => c.read(n),
      version: (n) => c.version(n),
      write: (n, v, version) => c.write(n, v, version),
      set: (n, v) => { c.write(n, v, c.version(n)); },
    };
  };
}
