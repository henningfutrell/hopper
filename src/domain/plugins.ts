// Plugin vocabulary (design.md "Phase 5 — every part is a plugin"; docs/glossary.md).

/** A slot the engine calls through one port. Each slice adds the roles it builds. */
export type Role = 'router' | 'answerer' | 'assessor' | 'executor' | 'job-source' | 'machine-source' | 'usage-source' | 'notifier';
export const ROLES: readonly Role[] = ['router', 'answerer', 'assessor', 'executor', 'job-source', 'machine-source', 'usage-source', 'notifier'];

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

/** GET /api/plugins. */
export interface PluginsReport {
  roles: Role[];
  /** `source: defaults`: plugins.yaml could not be read at start, so the built-in instances run. */
  config: { path: string; source: 'file' | 'defaults'; loadedAt?: string; error?: string; warnings: string[] };
  router: { instance: InstanceSpec; selection: RouterSelection; detection: Detection; active: string; fallback: boolean; reason?: string };
  answerer: QuestionRoleStatus;
  assessor: QuestionRoleStatus;
  /** The restart roles, as built at start. */
  executors: RestartRoleStatus;
  jobSources: RestartRoleStatus;
  /** One instance (the machine source); a list like the others. */
  machines: RestartRoleStatus;
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
