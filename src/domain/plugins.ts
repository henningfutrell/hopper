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

/** GET /api/plugins. */
export interface PluginsReport {
  roles: Role[];
  config: { path: string; source: 'file' | 'env'; loadedAt?: string; error?: string; warnings: string[] };
  router: { instance: InstanceSpec; detection: Detection; active: string; fallback: boolean; reason?: string };
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
