// Config documents for a unit test of a part that reads them (the plugin host, an editor): the
// real store's, in a temp database, removed after each test.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach } from 'vitest';
import { stringify } from 'yaml';
import type { ConfigDocuments, UserDocumentName, UserStore } from '../../src/domain/ports.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { testDatabaseUrl } from './database.ts';

export interface TempDocuments extends ConfigDocuments {
  /** Replace a document whatever its version; `doc` text, or a value written as YAML. */
  set(name: UserDocumentName, doc: unknown): void;
  store: UserStore;
}

/** Call at module level: `const docs = useTempDocuments();` then `docs()` in a test for a fresh, empty set. */
export function useTempDocuments(): () => TempDocuments {
  const open: { store: UserStore; dir: string }[] = [];
  afterEach(() => {
    for (const o of open.splice(0)) { o.store.close(); rmSync(o.dir, { recursive: true, force: true }); }
  });
  return () => {
    const dir = mkdtempSync(`${tmpdir()}/jh-docs-`);
    const instance = openInstanceStore({ url: testDatabaseUrl(), clock: { now: () => new Date() } });
    const owner = instance.userStore(instance.users.owner());
    const store: UserStore = { ...owner, close: () => { owner.close(); instance.close(); } };
    open.push({ store, dir });
    const d = store.documents;
    return {
      store,
      read: (n) => d.read(n),
      version: (n) => d.version(n),
      write: (n, t, v) => d.write(n, t, v),
      set: (n, doc) => { d.write(n, typeof doc === 'string' ? doc : stringify(doc), d.version(n)); },
    };
  };
}
