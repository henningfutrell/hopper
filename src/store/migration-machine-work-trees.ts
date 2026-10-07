// Tenant migration 14 (issue #361): a work tree is set per machine. Every stored path that named no
// machine — a job source's `defaultCwd` and `repoPaths`, a work tree executor's `cwd`, a routing rule's
// `workTree` without a machine — leaves the plugins config, and what it meant moves onto a machine:
// - the path a job with none of its own fell back to (the first job source's `defaultCwd`, else the first
//   work tree executor's `cwd`) becomes the work tree of each machine (`local`, `ssh`, `client`) that has
//   none; the jobs directory itself is the default and is not written;
// - a repository's own path that is not that work tree becomes a routing rule pinning the repository's
//   jobs to the one machine there is, after the rules there are; with several machines it is dropped;
// - a routing rule's work tree without a machine is pinned to the one machine there is; with several the
//   work tree goes, and a rule left setting nothing goes with it.
// Waiting and ended jobs keep a payload `cwd` only when a rule pinned it to their machine; `defaultCwd`
// leaves every job. Every other value stays.
import type { Db } from './db.ts';

const JOBS_DIR = '~/hopper-jobs';
const WORK_TREE_EXECUTORS = new Set(['herdr-claude', 'cursor-agent', 'codex', 'opencode', 'omp']);
const WORK_TREE_MACHINES = new Set(['local', 'ssh', 'client']);

interface Instance { name?: unknown; plugin?: unknown; options?: Record<string, unknown> | null }
interface Rule { name?: unknown; match?: Record<string, unknown>; set?: Record<string, unknown> }
interface Plugins { machines?: unknown; executors?: unknown; jobSources?: unknown; routing?: unknown }

const list = <T>(v: unknown): T[] => (Array.isArray(v) ? v as T[] : []);
const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

function migratePlugins(value: Plugins): boolean {
  const machines = list<Instance>(value.machines).filter((m) => WORK_TREE_MACHINES.has(String(m?.plugin)));
  const sources = list<Instance>(value.jobSources);
  const executors = list<Instance>(value.executors).filter((e) => WORK_TREE_EXECUTORS.has(String(e?.plugin)));
  const fallback = sources.map((s) => text(s.options?.defaultCwd)).find(Boolean) ?? executors.map((e) => text(e.options?.cwd)).find(Boolean);
  const only = machines.length === 1 ? text(machines[0]!.name) : undefined;
  let changed = false;

  if (fallback && fallback !== JOBS_DIR) {
    for (const m of machines) {
      if (text(m.options?.workTree)) continue;
      m.options = { ...(m.options ?? {}), workTree: fallback };
      changed = true;
    }
  }

  const added: Rule[] = [];
  for (const s of sources) {
    const o = s.options;
    if (!o || typeof o !== 'object') continue;
    const paths = o.repoPaths;
    if (paths && typeof paths === 'object' && !Array.isArray(paths) && only) {
      for (const [repo, path] of Object.entries(paths as Record<string, unknown>)) {
        if (!text(path) || path === fallback) continue;
        added.push({ name: `${String(s.name)} ${repo}`, match: { source: String(s.name), repo }, set: { machine: only, workTree: path as string } });
      }
    }
    if ('repoPaths' in o) { delete o.repoPaths; changed = true; }
    if ('defaultCwd' in o) { delete o.defaultCwd; changed = true; }
  }
  for (const e of executors) {
    if (e.options && 'cwd' in e.options) { delete e.options.cwd; changed = true; }
  }

  if (Array.isArray(value.routing)) {
    const kept: Rule[] = [];
    for (const r of value.routing as Rule[]) {
      if (!r?.set || r.set.workTree === undefined || r.set.machine !== undefined) { kept.push(r); continue; }
      changed = true;
      if (only) { kept.push({ ...r, set: { ...r.set, machine: only } }); continue; }
      const { workTree: _drop, ...rest } = r.set;
      if (Object.keys(rest).length > 0) kept.push({ ...r, set: rest });
    }
    value.routing = kept;
  }
  if (added.length > 0) {
    value.routing = [...list<Rule>(value.routing), ...added];
    changed = true;
  }
  return changed;
}

interface StoredJob { spec?: { machineId?: unknown; routedBy?: { set?: { machine?: unknown; workTree?: unknown } }; payload?: Record<string, unknown> } }

/** A job's payload keeps `cwd` only when a routing rule set it with the machine the job is pinned to. */
function migrateJob(job: StoredJob): boolean {
  const payload = job.spec?.payload;
  if (!payload || typeof payload !== 'object') return false;
  let changed = false;
  if ('defaultCwd' in payload) { delete payload.defaultCwd; changed = true; }
  const set = job.spec?.routedBy?.set;
  const pinned = set?.workTree !== undefined && set.machine !== undefined && set.machine === job.spec?.machineId;
  if ('cwd' in payload && !pinned) { delete payload.cwd; changed = true; }
  return changed;
}

export function machineWorkTrees(db: Db): void {
  const row = db.get("SELECT value FROM config WHERE name = 'plugins'");
  if (row) {
    const value = JSON.parse(String(row.value)) as Plugins;
    if (migratePlugins(value)) db.run("UPDATE config SET value = ? WHERE name = 'plugins'", JSON.stringify(value));
  }
  for (const j of db.all('SELECT id, body FROM jobs')) {
    const job = JSON.parse(String(j.body)) as StoredJob;
    if (migrateJob(job)) db.run('UPDATE jobs SET body = ? WHERE id = ?', JSON.stringify(job), String(j.id));
  }
}
