// The plugin store (design.md "Plugin store", issue #75): the catalogue of the git repository the
// operator names (JOB_HOPPER_PLUGIN_STORE), read in the background; installs, updates and removes
// store installs under the plugin dir, one edit at a time. An install is unpacked beside its target,
// proven to load as the catalogue says, then renamed into place; the plugin host rescans.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock, EventLog, PluginsView } from '../domain/ports.ts';
import { ROLES, type PluginStoreEdit, type PluginStoreEditOutcome, type PluginStoreEntry, type PluginStoreReport, type Role } from '../domain/types.ts';
import { importPlugin } from './loader.ts';
import { CATALOGUE, parseCatalogue, type CatalogueEntry } from './plugin-store-catalogue.ts';
import { createStoreMirror, type StoreMirror } from './plugin-store-git.ts';
import type { PluginLogger } from './sdk.ts';

/** In a store install's directory: where it came from. */
export const MARKER = '.plugin-store.json';

interface Marker { role: Role; describe: string; commit: string; tree: string; installedAt: string }

export interface PluginStoreOptions {
  /** JOB_HOPPER_PLUGIN_STORE. */
  repo?: string;
  /** JOB_HOPPER_PLUGIN_DIR. */
  pluginDir?: string;
  workDir: string;
  builtinIds: ReadonlySet<string>;
  plugins: Pick<PluginsView, 'report' | 'edit'>;
  events: Pick<EventLog, 'append'>;
  clock: Clock;
  logger: PluginLogger;
  mirror?: StoreMirror;
}

export interface PluginStore {
  /** Read the catalogue in the background. */
  start(): void;
  report(): PluginStoreReport;
  edit(e: PluginStoreEdit): Promise<PluginStoreEditOutcome>;
}

type Refusal = Extract<PluginStoreEditOutcome, { ok: false }>;
const refuse = (code: Refusal['code'], error: string): Refusal => ({ ok: false, code, error });
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function readMarker(dir: string): Marker | undefined {
  try {
    const m = JSON.parse(readFileSync(join(dir, MARKER), 'utf8')) as Partial<Marker>;
    if (typeof m.commit !== 'string' || typeof m.tree !== 'string' || !(ROLES as readonly unknown[]).includes(m.role)) return undefined;
    return { role: m.role as Role, describe: String(m.describe ?? ''), commit: m.commit, tree: m.tree, installedAt: String(m.installedAt ?? '') };
  } catch {
    return undefined;
  }
}

export function createPluginStore(o: PluginStoreOptions): PluginStore {
  const unavailable = o.repo === undefined
    ? 'no plugin store: set JOB_HOPPER_PLUGIN_STORE to a git repository holding plugin-store.yaml'
    : o.pluginDir === undefined ? 'no plugin dir to install into: set JOB_HOPPER_PLUGIN_DIR' : undefined;
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

  /** Store installs under the plugin dir, by id. */
  function installs(): Map<string, Marker> {
    const out = new Map<string, Marker>();
    if (o.pluginDir === undefined || !existsSync(o.pluginDir)) return out;
    for (const e of readdirSync(o.pluginDir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const m = readMarker(join(o.pluginDir, e.name));
      if (m) out.set(e.name, m);
    }
    return out;
  }

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
      o.logger.warn(`job-hopper: ${error}`);
    }
    checkedAt = o.clock.now().toISOString();
  }

  /** Unpack, prove it loads as the catalogue says, mark it; the staging directory, ready to rename. */
  async function stage(c: CatalogueEntry & { tree?: string }, at: string, dir: string, staging: string): Promise<Refusal | undefined> {
    if (c.tree === undefined) return refuse('conflict', `${c.path} is not a directory in the plugin store at ${at}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    await mirror.extract(at, c.path, staging);
    const index = ['index.ts', 'index.js'].map((f) => join(staging, f)).find((p) => existsSync(p));
    if (!index) return refuse('conflict', `${c.id}: no index.ts or index.js in ${c.path}`);
    const r = await importPlugin(index);
    if ('error' in r) return refuse('conflict', `${c.id} does not load: ${r.error}`);
    if (r.definition.id !== c.id) return refuse('conflict', `${c.path} declares id ${r.definition.id}, not ${c.id} as ${CATALOGUE} says`);
    if (r.definition.role !== c.role) return refuse('conflict', `${c.id} declares role ${r.definition.role}, not ${c.role} as ${CATALOGUE} says`);
    const marker: Marker = { role: c.role, describe: c.describe, commit: at, tree: c.tree, installedAt: o.clock.now().toISOString() };
    writeFileSync(join(staging, MARKER), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
    return undefined;
  }

  async function install(id: string): Promise<PluginStoreEditOutcome> {
    const dir = o.pluginDir;
    const c = catalogue.find((x) => x.id === id);
    if (unavailable || dir === undefined) return refuse('conflict', unavailable ?? 'no plugin dir');
    if (!c || commit === undefined) return refuse('not_found', `the plugin store does not list ${id}`);
    if (o.builtinIds.has(id)) return refuse('conflict', `${id} is a built-in plugin`);
    const target = join(dir, id);
    if (existsSync(target) && !readMarker(target)) {
      return refuse('conflict', `${target} is not a store install: a plugin put there by hand is never overwritten`);
    }
    const at = commit;
    const staging = join(dir, `.install-${id}-${randomUUID().slice(0, 8)}`);
    try {
      const refused = await stage(c, at, dir, staging);
      if (refused) return refused;
      noteLoaded();
      rmSync(target, { recursive: true, force: true });
      renameSync(staging, target);
    } catch (e) {
      return refuse('conflict', `installing ${id} failed: ${message(e)}`);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    if (loaded.has(id)) pending.add(id);
    await o.plugins.edit({ action: 'rescan' });
    noteLoaded();
    o.events.append({ type: 'plugin.installed', data: { id, role: c.role, commit: at } });
    o.logger.info(`job-hopper: plugin ${id} installed from the plugin store at ${at}${pending.has(id) ? ' — restart pending' : ''}`);
    return { ok: true, report: report() };
  }

  async function remove(id: string): Promise<PluginStoreEditOutcome> {
    const dir = o.pluginDir;
    if (dir === undefined || !readMarker(join(dir, id))) return refuse('not_found', `${id} is not a store install`);
    // Rescan first: it reloads plugins.yaml, so a change the watch has not read yet counts.
    await o.plugins.edit({ action: 'rescan' });
    const r = o.plugins.report();
    const users = [
      ...r.instances.filter((i) => i.instance.plugin === id).map((i) => `${i.role} ${i.instance.name}`),
      ...(r.router.active === id && !r.instances.some((i) => i.role === 'router' && i.instance.plugin === id) ? ['the detected router'] : []),
    ];
    if (users.length > 0) return refuse('conflict', `${id} is in use by ${users.join(', ')}: change plugins.yaml first`);
    rmSync(join(dir, id), { recursive: true, force: true });
    pending.delete(id);
    await o.plugins.edit({ action: 'rescan' });
    o.events.append({ type: 'plugin.removed', data: { id } });
    o.logger.info(`job-hopper: plugin ${id} removed (a store install)`);
    return { ok: true, report: report() };
  }

  return {
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
