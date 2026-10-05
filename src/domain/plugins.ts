// Plugin vocabulary (design.md "Phase 5 — every part is a plugin"; docs/glossary.md).

/** A slot the engine calls through one port. Each slice adds the roles it builds. */
export type Role = 'router' | 'queue-sorter' | 'escalation-level' | 'executor' | 'job-source' | 'machine-source' | 'usage-source' | 'notifier';
export const ROLES: readonly Role[] = ['router', 'queue-sorter', 'escalation-level', 'executor', 'job-source', 'machine-source', 'usage-source', 'notifier'];

/** The roles built once at start; a later plugins.yaml change applies at the next restart. */
export type RestartRole = 'executor' | 'job-source' | 'machine-source' | 'usage-source' | 'notifier';

/** A plugin's cheap check of whether it can run on this machine. */
export type Detection =
  | { status: 'available'; detail?: string }
  | { status: 'unavailable'; reason: string }
  | { status: 'needs-setup'; reason: string; command: string };

/** A plugin plus options, under a name (plugins.yaml). */
export interface InstanceSpec {
  name: string;
  plugin: string;
  options?: Record<string, unknown>;
}

/** How the router instance was chosen: named in plugins.yaml, or the first router that can run here. */
export type RouterSelection = 'file' | 'detected';

/** The router as /api/health and /api/router report it. */
export interface RouterStatus {
  /** The configured instance name (e.g. "gate-router"). */
  name: string;
  /** The plugin answering now: the instance's, or "pass-through" when it fell back. */
  plugin: string;
  /** True while advice is falling back: the instance could not start, or its last advice was `source: fallback`. */
  fallback: boolean;
  reason?: string;
}

/** A configured executor that cannot run: the jobs naming it are held with this reason. */
export interface ExecutorUnavailable {
  /** The instance name (what `spec.executor` names). */
  name: string;
  reason: string;
}

/**
 * One instance of a restart role in GET /api/plugins. `active` null: it cannot run (`reason`) — an
 * executor's jobs are held, a job or usage source or a notifier is dropped, a machine source leaves no machine.
 */
export interface InstanceStatus {
  instance: InstanceSpec;
  detection: Detection;
  active: string | null;
  reason?: string;
}

/**
 * A restart role in GET /api/plugins: the instances running since start. `pending`: plugins.yaml
 * now names other instances (or, with the section removed, the built-in ones differ); they apply
 * at the next restart.
 */
export interface RestartRoleStatus {
  instances: InstanceStatus[];
  pending?: { status: 'changed — restart pending'; instances: InstanceSpec[] };
}

/** One instance as plugins.yaml (or, with no section, the built-in instances) names it now: what an options edit acts on. */
export interface ConfiguredInstance {
  role: Role;
  instance: InstanceSpec;
}

/** The roles with exactly one instance, whose plugin the UI may select. */
export type SelectableRole = 'router' | 'queue-sorter';
export const SELECTABLE_ROLES: readonly SelectableRole[] = ['router', 'queue-sorter'];

/** The roles with 0..n instances (executors: 1..n), each added or removed from the UI under its own name. */
export type ListRole = 'escalation-level' | 'executor' | 'job-source' | 'machine-source' | 'usage-source' | 'notifier';
export const LIST_ROLES: readonly ListRole[] = ['escalation-level', 'executor', 'job-source', 'machine-source', 'usage-source', 'notifier'];

/** The queue order (DecisionInputs.queueOrder): the waiting jobs as the queue sorter ordered them, and which instance did. */
export interface QueueOrder {
  /** The queue-sorter instance name. */
  sorter: string;
  /** Job ids. */
  jobIds: string[];
}

/**
 * The queue sorter in GET /api/plugins. `active`: the plugin answering — `priority` when the
 * configured one cannot run. `fallback`: it cannot run, or its last sort threw or returned garbage
 * (that call answered with priority's order); `reason` says which.
 */
export interface QueueSorterStatus {
  instance: InstanceSpec;
  detection: Detection;
  active: string;
  fallback: boolean;
  reason?: string;
}

/**
 * POST /ui/api/plugins (design.md "UI and mutation"). `version` is GET /api/plugins
 * `config.version`, read with the form: a file changed since is refused.
 */
export type PluginsEdit =
  /** One instance's whole options object; command-bearing values must equal the file's. */
  | { action: 'options'; role: Role; name: string; options: Record<string, unknown>; version: string }
  /** A plugin, detected available, fills the role under its own id. */
  | { action: 'select'; role: SelectableRole; plugin: string; version: string }
  /** A plugin, detected available, as a new instance `name` of a list role, with the plugin's defaults. */
  | { action: 'add'; role: ListRole; plugin: string; name: string; version: string }
  /** Instance `name` of a list role leaves plugins.yaml; an executor still named elsewhere is refused. */
  | { action: 'remove'; role: ListRole; name: string; version: string }
  /** Escalation level `name` moves to position `to` (0 is the lowest level); the others keep their order. */
  | { action: 'move'; role: 'escalation-level'; name: string; to: number; version: string }
  /** Load custom plugins added since start and re-run every detection. */
  | { action: 'rescan' };

export type PluginsEditOutcome =
  | { ok: true; report: PluginsReport }
  | { ok: false; code: 'invalid' | 'not_found' | 'conflict'; error: string };

/** GET /api/plugins. */
export interface PluginsReport {
  roles: Role[];
  /**
   * `source: defaults`: plugins.yaml could not be read at start, so the built-in instances run.
   * `version`: sha-256 of plugins.yaml, or `missing`; an edit carries it back.
   */
  config: { document: string; source: 'document' | 'defaults'; version: string; loadedAt?: string; error?: string; warnings: string[] };
  /** Every configured instance, by role — each one's options are its own. */
  instances: ConfiguredInstance[];
  router: { instance: InstanceSpec; selection: RouterSelection; detection: Detection; active: string; fallback: boolean; reason?: string };
  queueSorter: QueueSorterStatus;
  /** The escalation levels now, lowest first (a live role). `active` null: that level cannot run, and escalates every question it gets. */
  escalationLevels: InstanceStatus[];
  /** The executors as plugins.yaml names them now: live since issue #142, never pending. */
  executors: { instances: InstanceStatus[] };
  /** The restart roles, as built at start. */
  jobSources: RestartRoleStatus;
  /** The machine sources — this machine and the attached ones (issue #74) — as plugins.yaml names them now: live, never pending. */
  machines: { instances: InstanceStatus[] };
  usageSources: RestartRoleStatus;
  notifiers: RestartRoleStatus;
  plugins: {
    id: string; role: Role; describe: string; builtin: boolean; path?: string;
    detection: Detection;
    /** The options as JSON Schema. */
    options: Record<string, unknown>;
  }[];
  /** Custom plugins refused at load. */
  errors: { path: string; error: string }[];
  warnings: string[];
}

/**
 * A store install, kept in the database (issue #93): what was installed from the plugin store. Its
 * code is unpacked into the work dir and restored from the store by `tree` (design.md "Plugin store").
 */
export interface PluginInstall { id: string; role: Role; describe: string; commit: string; tree: string; installedAt: string }

/** One plugin of the plugin store in GET /api/plugin-store (design.md "Plugin store"). */
export interface PluginStoreEntry {
  id: string;
  role: Role;
  describe: string;
  /** In the store catalogue now; false: a store install the catalogue no longer lists. */
  listed: boolean;
  /** A store install. `current`: its directory equals the catalogue's at the store's head. */
  installed?: { commit: string; installedAt: string; current: boolean };
  /** Installed again since start: the daemon still runs the code it first loaded. */
  restartPending: boolean;
}

/**
 * GET /api/plugin-store. `unavailable`: no plugin store (`reason`). `error`: the last
 * read failed (`error`); `commit`, `checkedAt` and the plugins are the last good read's.
 */
export interface PluginStoreReport {
  state: 'unavailable' | 'ready' | 'error';
  reason?: string;
  error?: string;
  /** HOPPER_PLUGIN_STORE. */
  repo?: string;
  /** The store's head the catalogue was read at. */
  commit?: string;
  checkedAt?: string;
  plugins: PluginStoreEntry[];
}

/** POST /ui/api/plugin-store. `install` also updates a store install to the store's head. */
export type PluginStoreEdit =
  | { action: 'refresh' }
  | { action: 'install'; id: string }
  | { action: 'remove'; id: string };

export type PluginStoreEditOutcome =
  | { ok: true; report: PluginStoreReport }
  | { ok: false; code: 'not_found' | 'conflict'; error: string };
