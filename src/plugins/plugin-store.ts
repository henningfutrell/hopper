// The plugin store (design.md "Plugin store", issue #75): the catalogue of the git repository the
// operator names (HOPPER_PLUGIN_STORE), read in the background; installs, updates and removes
// store installs, one edit at a time. A store install is kept in the database (issue #93); its code
// is unpacked into the work dir, proven to load as the catalogue says, renamed into place, and the
// plugin host rescans. The work dir is scratch: `restore` unpacks every store install again at start.
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock, EventLog, PluginsView, SettingsRepository } from '../domain/ports.ts';
import { ROLES, type PluginInstall, type PluginStoreEdit, type PluginStoreEditOutcome, type PluginStoreEntry, type PluginStoreReport, type Role } from '../domain/types.ts';
import { importPlugin } from './loader.ts';
import { CATALOGUE, parseCatalogue, type CatalogueEntry } from './plugin-store-catalogue.ts';
import { createStoreMirror, type StoreMirror } from './plugin-store-git.ts';
import type { PluginLogger } from './sdk.ts';

/** Where a store install's directory said where it came from, when store installs lived in the plugin dir. */
const MARKER = '.plugin-store.json';

/** Where store installs are unpacked: scratch, restored at start. */
export const installedDirOf = (workDir: string): string => join(workDir, 'plugin-store', 'installed');

export interface PluginStoreOptions {
  /** HOPPER_PLUGIN_STORE. */
  repo?: string;
  /** HOPPER_PLUGIN_DIR: the operator's plugins, never written but to move a store install left there into the database. */
  pluginDir?: string;
  workDir: string;
  installs: Pick<SettingsRepository, 'getPluginInstalls' | 'setPluginInstalls'>;
  builtinIds: ReadonlySet<string>;
  plugins: Pick<PluginsView, 'report' | 'edit'>;
  events: Pick<EventLog, 'append'>;
  clock: Clock;
  logger: PluginLogger;
  mirror?: StoreMirror;
}

export interface PluginStore {
  /** Unpack every store install into the work dir (fetching the store when one is missing); before the plugin host starts. */
  restore(): Promise<void>;
  /** Read the catalogue in the background. */
  start(): void;
  report(): PluginStoreReport;
  edit(e: PluginStoreEdit): Promise<PluginStoreEditOutcome>;
}

type Refusal = Extract<PluginStoreEditOutcome, { ok: false }>;
const refuse = (code: Refusal['code'], error: string): Refusal => ({ ok: false, code, error });
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A store install left in the plugin dir by an earlier version, or undefined. */
function readMarker(id: string, dir: string): PluginInstall | undefined {
  try {
    const m = JSON.parse(readFileSync(join(dir, MARKER), 'utf8')) as Partial<PluginInstall>;
    if (typeof m.commit !== 'string' || typeof m.tree !== 'string' || !(ROLES as readonly unknown[]).includes(m.role)) return undefined;
    return { id, role: m.role as Role, describe: String(m.describe ?? ''), commit: m.commit, tree: m.tree, installedAt: String(m.installedAt ?? '') };
  } catch {
    return undefined;
  }
}

export function createPluginStore(o: PluginStoreOptions): PluginStore {
  const unavailable = o.repo === undefined ? 'no plugin store: set HOPPER_PLUGIN_STORE to a git repository holding plugin-store.yaml' : undefined;
  const dir = installedDirOf(o.workDir);
  const mirror = o.mirror ?? createStoreMirror(join(o.workDir, 'plugin-store', 'repo.git'));
  let catalogue: (CatalogueEntry & { tree?: string })[] = [];
  let commit: string | undefined;
  let checkedAt: string | undefined;
  let error: string | undefined;
  /** Custom plugin ids this process has imported: installing one again needs a restart (Node caches imports). */
  const loaded = new Set<string>();
  const pending = new Set<string>();
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const next = chain.then(f, f);
    chain = next.catch(() => undefined);
    return next;
  };

  const noteLoaded = (): void => {
    for (const p of o.plugins.report().plugins) if (!p.builtin) loaded.add(p.id);
  };

  const installs = (): Map<string, PluginInstall> => new Map(o.installs.getPluginInstalls().map((i) => [i.id, i]));
  const keep = (id: string, i: PluginInstall | undefined): void => {
    const all = installs();
    if (i) all.set(id, i);
    else all.delete(id);
    o.installs.setPluginInstalls([...all.values()]);
  };

  function report(): PluginStoreReport {
    if (unavailable) return { state: 'unavailable', reason: unavailable, ...(o.repo ? { repo: o.repo } : {}), plugins: [] };
    const mine = installs();
    const entry = (id: string, role: Role, describe: string, listed: boolean, tree?: string): PluginStoreEntry => {
      const m = mine.get(id);
      return {
        id, role, describe, listed,
        ...(m ? { installed: { commit: m.commit, installedAt: m.installedAt, current: tree !== undefined && m.tree === tree } } : {}),
        restartPending: pending.has(id),
      };
    };
    const listed = new Set(catalogue.map((c) => c.id));
    return {
      state: error ? 'error' : 'ready',
      ...(error ? { error } : {}),
      repo: o.repo,
      ...(commit ? { commit } : {}),
      ...(checkedAt ? { checkedAt } : {}),
      plugins: [
        ...catalogue.map((c) => entry(c.id, c.role, c.describe, true, c.tree)),
        ...[...mine].filter(([id]) => !listed.has(id)).sort(([a], [b]) => a.localeCompare(b)).map(([id, m]) => entry(id, m.role, m.describe, false)),
      ],
    };
  }

  async function refresh(): Promise<void> {
    if (unavailable || o.repo === undefined) return;
    try {
      const head = await mirror.fetch(o.repo);
      const text = await mirror.show(head, CATALOGUE);
      if (text === undefined) throw new Error(`${CATALOGUE}: not in the store's default branch`);
      const r = parseCatalogue(text);
      if ('error' in r) throw new Error(r.error);
      catalogue = await Promise.all(r.plugins.map(async (p) => {
        const tree = await mirror.tree(head, p.path);
        return tree === undefined ? p : { ...p, tree };
      }));
      commit = head;
      error = undefined;
    } catch (e) {
      error = `plugin store ${o.repo}: ${message(e)}`;
      o.logger.warn(`hopper: ${error}`);
    }
    checkedAt = o.clock.now().toISOString();
  }

  /** A store install an earlier version left in the plugin dir, moved into the database and the work dir. */
  function adopt(): void {
    if (o.pluginDir === undefined || !existsSync(o.pluginDir)) return;
    for (const e of readdirSync(o.pluginDir, { withFileTypes: true })) {
      const from = join(o.pluginDir, e.name);
      const found = e.isDirectory() && !e.name.startsWith('.') ? readMarker(e.name, from) : undefined;
      if (!found || installs().has(found.id)) continue;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      rmSync(join(dir, found.id), { recursive: true, force: true });
      cpSync(from, join(dir, found.id), { recursive: true });
      rmSync(join(dir, found.id, MARKER), { force: true });
      keep(found.id, found);
      rmSync(from, { recursive: true, force: true });
      o.logger.info(`hopper: store install ${found.id} moved from the plugin dir into the database`);
    }
  }

  async function restore(): Promise<void> {
    adopt();
    const missing = [...installs().values()].filter((i) => !existsSync(join(dir, i.id)));
    if (missing.length === 0) return;
    if (o.repo === undefined) {
      o.logger.warn(`hopper: store installs ${missing.map((i) => i.id).join(', ')} not restored: ${unavailable}`);
      return;
    }
    await refresh();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const i of missing) {
      try {
        await mirror.extract(i.tree, join(dir, i.id));
      } catch (e) {
        rmSync(join(dir, i.id), { recursive: true, force: true });
        o.logger.warn(`hopper: store install ${i.id} not restored from ${o.repo} at ${i.commit}: ${message(e)}`);
      }
    }
  }

  /** Unpack, prove it loads as the catalogue says; the staging directory, ready to rename. */
  async function stage(c: CatalogueEntry & { tree?: string }, at: string, staging: string): Promise<Refusal | undefined> {
    if (c.tree === undefined) return refuse('conflict', `${c.path} is not a directory in the plugin store at ${at}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    await mirror.extract(`${at}:${c.path}`, staging);
    const index = ['index.ts', 'index.js'].map((f) => join(staging, f)).find((p) => existsSync(p));
    if (!index) return refuse('conflict', `${c.id}: no index.ts or index.js in ${c.path}`);
    const r = await importPlugin(index);
    if ('error' in r) return refuse('conflict', `${c.id} does not load: ${r.error}`);
    if (r.definition.id !== c.id) return refuse('conflict', `${c.path} declares id ${r.definition.id}, not ${c.id} as ${CATALOGUE} says`);
    if (r.definition.role !== c.role) return refuse('conflict', `${c.id} declares role ${r.definition.role}, not ${c.role} as ${CATALOGUE} says`);
    return undefined;
  }

  async function install(id: string): Promise<PluginStoreEditOutcome> {
    const c = catalogue.find((x) => x.id === id);
    if (unavailable) return refuse('conflict', unavailable);
    if (!c || commit === undefined) return refuse('not_found', `the plugin store does not list ${id}`);
    if (o.builtinIds.has(id)) return refuse('conflict', `${id} is a built-in plugin`);
    if (o.pluginDir !== undefined && existsSync(join(o.pluginDir, id))) {
      return refuse('conflict', `${join(o.pluginDir, id)} is in the plugin dir: a plugin put there by hand is the operator's, never replaced from the plugin store`);
    }
    const at = commit;
    const target = join(dir, id);
    const staging = join(dir, `.install-${id}-${randomUUID().slice(0, 8)}`);
    try {
      const refused = await stage(c, at, staging);
      if (refused) return refused;
      noteLoaded();
      rmSync(target, { recursive: true, force: true });
      renameSync(staging, target);
      keep(id, { id, role: c.role, describe: c.describe, commit: at, tree: c.tree!, installedAt: o.clock.now().toISOString() });
    } catch (e) {
      return refuse('conflict', `installing ${id} failed: ${message(e)}`);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    if (loaded.has(id)) pending.add(id);
    await o.plugins.edit({ action: 'rescan' });
    noteLoaded();
    o.events.append({ type: 'plugin.installed', data: { id, role: c.role, commit: at } });
    o.logger.info(`hopper: plugin ${id} installed from the plugin store at ${at}${pending.has(id) ? ' — restart pending' : ''}`);
    return { ok: true, report: report() };
  }

  async function remove(id: string): Promise<PluginStoreEditOutcome> {
    if (!installs().has(id)) return refuse('not_found', `${id} is not a store install`);
    // Rescan first: it reloads plugins.yaml, so a change the watch has not read yet counts.
    await o.plugins.edit({ action: 'rescan' });
    const r = o.plugins.report();
    const users = [
      ...r.instances.filter((i) => i.instance.plugin === id).map((i) => `${i.role} ${i.instance.name}`),
      ...(r.router.active === id && !r.instances.some((i) => i.role === 'router' && i.instance.plugin === id) ? ['the detected router'] : []),
    ];
    if (users.length > 0) return refuse('conflict', `${id} is in use by ${users.join(', ')}: change plugins.yaml first`);
    keep(id, undefined);
    rmSync(join(dir, id), { recursive: true, force: true });
    pending.delete(id);
    await o.plugins.edit({ action: 'rescan' });
    o.events.append({ type: 'plugin.removed', data: { id } });
    o.logger.info(`hopper: plugin ${id} removed (a store install)`);
    return { ok: true, report: report() };
  }

  return {
    restore: () => serial(restore),
    start() {
      if (!unavailable) void serial(refresh);
    },
    report,
    edit(e) {
      return serial(async (): Promise<PluginStoreEditOutcome> => {
        if (e.action === 'refresh') {
          await refresh();
          return { ok: true, report: report() };
        }
        return e.action === 'install' ? install(e.id) : remove(e.id);
      });
    },
  };
}
