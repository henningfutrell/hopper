// Plugin vocabulary (design.md "Phase 5 — every part is a plugin"; docs/glossary.md).

/** A slot the engine calls through one port. Slice 1 has the router; later slices add roles. */
export type Role = 'router';
export const ROLES: readonly Role[] = ['router'];

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

/** GET /api/plugins. */
export interface PluginsReport {
  roles: Role[];
  config: { path: string; source: 'file' | 'env'; loadedAt?: string; error?: string; warnings: string[] };
  router: { instance: InstanceSpec; detection: Detection; active: string; fallback: boolean; reason?: string };
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
