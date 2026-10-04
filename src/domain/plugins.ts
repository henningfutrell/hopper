// Plugin vocabulary (design.md "Phase 5 — every part is a plugin"; docs/glossary.md).

/** A slot the engine calls through one port. Each slice adds the roles it builds. */
export type Role = 'router' | 'answerer' | 'assessor' | 'executor';
export const ROLES: readonly Role[] = ['router', 'answerer', 'assessor', 'executor'];

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
  /** The configured instance name (e.g. "jev"). */
  name: string;
  /** The plugin answering now: the instance's, or "pass-through" when it fell back. */
  plugin: string;
  /** True while advice is falling back: the instance could not start, or its last advice was `source: fallback`. */
  fallback: boolean;
  reason?: string;
}

/**
 * A question role in GET /api/plugins. `instance` null: no answerer configured (plugins.yaml
 * `answerer: null`). `active` is the plugin answering now: null for an answerer that cannot run
 * (questions go to the human), `always-escalate` for an assessor that cannot (`fallback` true).
 */
export interface QuestionRoleStatus {
  instance: InstanceSpec | null;
  detection?: Detection;
  active: string | null;
  fallback: boolean;
  reason?: string;
}

/** A configured executor that cannot run: the jobs naming it are held with this reason. */
export interface ExecutorUnavailable {
  /** The instance name (what `spec.executor` names). */
  name: string;
  reason: string;
}

/** One executor instance in GET /api/plugins. `active` null: it cannot run (`reason`); its jobs are held. */
export interface ExecutorInstanceStatus {
  instance: InstanceSpec;
  detection: Detection;
  active: string | null;
  reason?: string;
}

/** One instance as plugins.yaml (or, with no section, the env) names it now: what an options edit acts on. */
export interface ConfiguredInstance {
  role: Role;
  instance: InstanceSpec;
}

/** The roles with exactly one instance (the answerer: 0..1), whose plugin the UI may select. */
export type SelectableRole = 'router' | 'answerer' | 'assessor';
export const SELECTABLE_ROLES: readonly SelectableRole[] = ['router', 'answerer', 'assessor'];

/**
 * POST /ui/api/plugins (design.md "UI and mutation"). `version` is GET /api/plugins
 * `config.version`, read with the form: a file changed since is refused.
 */
export type PluginsEdit =
  /** One instance's whole options object; command-bearing values must equal the file's. */
  | { action: 'options'; role: Role; name: string; options: Record<string, unknown>; version: string }
  /** A plugin, detected available, fills the role under its own id; `null`: no answerer. */
  | { action: 'select'; role: SelectableRole; plugin: string | null; version: string }
  /** Load custom plugins added since start and re-run every detection. */
  | { action: 'rescan' };

export type PluginsEditOutcome =
  | { ok: true; report: PluginsReport }
  | { ok: false; code: 'invalid' | 'not_found' | 'conflict'; error: string };

/** GET /api/plugins. */
export interface PluginsReport {
  roles: Role[];
  /** `version`: sha-256 of plugins.yaml, or `missing`; an edit carries it back. */
  config: { path: string; source: 'file' | 'env'; version: string; loadedAt?: string; error?: string; warnings: string[] };
  /** Every configured instance, by role — each one's options are its own. */
  instances: ConfiguredInstance[];
  router: { instance: InstanceSpec; selection: RouterSelection; detection: Detection; active: string; fallback: boolean; reason?: string };
  answerer: QuestionRoleStatus;
  assessor: QuestionRoleStatus;
  /**
   * The executors running since start (a restart role). `pending`: plugins.yaml (or the env, with
   * no `executors` section) now names other instances; they apply at the next restart.
   */
  executors: {
    instances: ExecutorInstanceStatus[];
    pending?: { status: 'changed — restart pending'; instances: InstanceSpec[] };
  };
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
