// The world the self-update tests run in: an upstream repository, a throwaway instance store and
// the updater under test, each cleaned up after the test.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { installFromBefore, testDatabaseUrl } from '../support/database.ts';
import type { InstanceStore, UserStore } from '../../src/domain/ports.ts';
import { ADMIN_ID } from '../../src/domain/types.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { createUpdater, type UpdaterOptions } from '../../src/update/index.ts';
import { copyBuilder, createUpstream, tempDir, type Upstream } from './support.ts';

const dirs: string[] = [];
const stores: { close(): void }[] = [];
const updaters: { stop(): void }[] = [];

afterEach(() => {
  for (const u of updaters.splice(0)) u.stop();
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

export interface World { root: string; up: Upstream; instance: InstanceStore; store: UserStore; dataDir: string }

export function world(): World {
  const root = tempDir('jh-update-');
  dirs.push(root);
  const dataDir = join(root, 'data');
  const instance = openInstanceStore({ url: installFromBefore(testDatabaseUrl()), clock: { now: () => new Date() } });
  const store = instance.userStore(instance.users.get(ADMIN_ID)!);
  stores.push(store, instance);
  return { root, up: createUpstream(root), instance, store, dataDir };
}

export function updater(w: World, appDir: string, o: Partial<UpdaterOptions> = {}) {
  const restarts: number[] = [];
  const u = createUpdater({
    appDir, dataDir: w.dataDir, settings: w.instance.settings, events: w.store.events, clock: { now: () => new Date() }, logger: { info: () => {}, warn: () => {} },
    builder: copyBuilder(), restart: async () => { restarts.push(Date.now()); }, restartBlockers: () => 0, checkMs: 0, waitMs: 20,
    ...o,
  });
  updaters.push(u);
  return { u, restarts };
}

export const types = (w: World, prefix = 'update.') => w.store.events.since(0).filter((e) => e.type.startsWith(prefix)).map((e) => e.type);
