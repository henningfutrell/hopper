// The Plugins view's model (design.md "Settled in slice 7"): an instance's state as GET /api/plugins
// reports it, the input each option gets (a choice where the plugin lists the values, issue #151), the whole options object one Save sends, and the name an
// added instance gets.
import type { ListRole, OptionChoice, PluginsEdit, PluginsReport, Role, SelectableRole } from '../../../src/domain/types.ts';

export interface OptionSchema {
  type?: string;
  enum?: unknown[];
  default?: unknown;
  description?: string;
  items?: { type?: string };
  /** `.meta({ commandBearing: true })`: names a program, its arguments, a directory, an executed file or where a credential goes; edited like any option (issue #198). */
  commandBearing?: boolean;
  /** `.meta({ machine: true })` (issue #174): a machine, picked from the configured ones; always set. */
  machine?: boolean;
}
export interface OptionsSchema { type?: string; properties?: Record<string, OptionSchema> }

/** What the form holds for one option, as typed: a string, or a boolean for a checkbox. */
export type Draft = Record<string, string | boolean>;

export type FieldKind = 'boolean' | 'enum' | 'choice' | 'number' | 'string' | 'lines' | 'json';

const isStringList = (p: OptionSchema) => p.type === 'array' && p.items?.type === 'string';

/** `choices`: the values the plugin listed for this option; any makes it a choice, never a typed value. */
export function fieldKind(p: OptionSchema, choices?: OptionChoice[]): FieldKind {
  if (p.machine) return 'choice';
  if (choices?.length) return 'choice';
  if (p.type === 'boolean') return 'boolean';
  if (Array.isArray(p.enum)) return 'enum';
  if (p.type === 'number' || p.type === 'integer') return 'number';
  if (p.type === 'string') return 'string';
  return isStringList(p) ? 'lines' : 'json';
}

/** An option's value as the form shows it. */
export function shown(p: OptionSchema, v: unknown): string {
  if (v === undefined) return '';
  if (isStringList(p) && Array.isArray(v)) return v.join('\n');
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** Drafts over the configured options; unknown keys exactly as configured. Throws on bad JSON. */
export function collectOptions(current: Record<string, unknown>, schema: OptionsSchema | undefined, draft: Draft): Record<string, unknown> {
  const props = schema?.properties ?? {};
  const out: Record<string, unknown> = Object.fromEntries(Object.entries(current).filter(([k]) => !(k in props)));
  for (const [k, p] of Object.entries(props)) {
    if (!(k in draft)) {
      if (k in current) out[k] = current[k];
      continue;
    }
    const raw = draft[k];
    if (raw === '' || raw === undefined) continue;
    const kind = fieldKind(p);
    if (kind === 'boolean') out[k] = raw === true;
    else if (kind === 'number') out[k] = Number(raw);
    else if (kind === 'string' || kind === 'enum' || kind === 'choice') out[k] = raw;
    else if (kind === 'lines') out[k] = String(raw).split('\n').map((l) => l.trim()).filter(Boolean);
    else {
      try { out[k] = JSON.parse(String(raw)); } catch { throw new Error(`${k}: not valid JSON`); }
    }
  }
  return out;
}

/** A plugin's machine options (issue #174): each names a configured machine, picked, never typed. */
export function machineOptions(schema: OptionsSchema | undefined): string[] {
  return Object.entries(schema?.properties ?? {}).filter(([, p]) => p.machine === true).map(([k]) => k);
}

/** The restart roles, by their key in GET /api/plugins. */
const RESTART = {
  'job-source': 'jobSources', 'usage-source': 'usageSources', notifier: 'notifiers',
} as const satisfies Partial<Record<Role, keyof PluginsReport>>;

export const SELECTABLE: readonly SelectableRole[] = ['router', 'queue-sorter'];
export const isSelectable = (role: Role): role is SelectableRole => (SELECTABLE as readonly Role[]).includes(role);

export const LIST: readonly ListRole[] = ['escalation-level', 'executor', 'job-source', 'machine-source', 'usage-source', 'notifier'];
export const isListRole = (role: Role): role is ListRole => (LIST as readonly Role[]).includes(role);

const ONE: Record<ListRole, string> = { 'escalation-level': 'an escalation level', executor: 'an executor', 'job-source': 'a job source', 'machine-source': 'a machine', 'usage-source': 'a usage source', notifier: 'a notifier' };

/** The name an added instance gets — what was typed, else the plugin id — and why it cannot have it. */
export function newInstance(report: PluginsReport, role: ListRole, plugin: string, typed: string): { name: string; problem?: string } {
  const name = typed.trim() || plugin;
  const taken = report.instances.some((i) => i.role === role && i.instance.name === name);
  return taken ? { name, problem: `${ONE[role]} is already named ${name}` } : { name };
}

export interface InstanceState {
  tone: 'ok' | 'warn' | 'bad';
  label: string;
  reason?: string;
  detection?: { status: string; reason?: string };
  /** A restart role whose section of the plugins config differs from what runs. */
  rolePending: boolean;
}

export function instanceState(report: PluginsReport, role: Role, name: string): InstanceState {
  const key = (RESTART as Partial<Record<Role, (typeof RESTART)[keyof typeof RESTART]>>)[role];
  const pending = { tone: 'warn' as const, label: 'restart pending' };
  if (role === 'machine-source' || role === 'executor') {
    // Live (issues #74, #142): what the plugins config names is what runs, once the reload after an edit is done.
    const s = (role === 'executor' ? report.executors : report.machines).instances.find((i) => i.instance.name === name);
    if (!s) return { tone: 'warn', label: 'applying', rolePending: false };
    const base = { ...(s.reason ? { reason: s.reason } : {}), detection: s.detection, rolePending: false };
    return s.active === null ? { tone: 'bad', label: 'cannot run', ...base } : { tone: 'ok', label: 'active', ...base };
  }
  if (key) {
    const slot = report[key];
    const rolePending = slot.pending !== undefined;
    const s = slot.instances.find((i) => i.instance.name === name);
    if (!s) return { ...pending, rolePending };
    const base = { ...(s.reason ? { reason: s.reason } : {}), detection: s.detection, rolePending };
    return s.active === null ? { tone: 'bad', label: 'cannot run', ...base } : { tone: 'ok', label: 'active', ...base };
  }
  if (role === 'escalation-level') {
    // A live role: an edit applies before the report comes back, so a level not in it is still loading.
    const l = report.escalationLevels.find((x) => x.instance.name === name);
    if (!l) return { tone: 'warn', label: 'loading', rolePending: false };
    const base = { ...(l.reason ? { reason: l.reason } : {}), detection: l.detection, rolePending: false };
    return l.active === null ? { tone: 'bad', label: 'cannot run', ...base } : { tone: 'ok', label: 'active', ...base };
  }
  const s = role === 'router' ? report.router : report.queueSorter;
  if (s.instance.name !== name) return { ...pending, rolePending: false };
  const base = { ...(s.reason ? { reason: s.reason } : {}), ...(s.detection ? { detection: s.detection } : {}), rolePending: false };
  if (s.active === null) return { tone: 'bad', label: 'cannot run', ...base };
  return s.fallback ? { tone: 'warn', label: `fallback: ${s.active}`, ...base } : { tone: 'ok', label: 'active', ...base };
}

export const ROLE_TITLES: Record<Role, string> = {
  router: 'Router', 'queue-sorter': 'Queue sorter', 'escalation-level': 'Escalation levels', executor: 'Executors',
  'job-source': 'Job sources', 'machine-source': 'Machine sources', 'usage-source': 'Usage sources', notifier: 'Notifiers',
};

/**
 * A shipped plugin as the Plugins view's switch shows it (issue #142; owner decision: users never edit
 * the plugins config). `blocked`: why a click cannot change it here.
 */
export interface ShippedPlugin { id: string; role: ListRole; describe: string; enabled: boolean; instances: string[]; blocked?: string }

/** The built-in plugins of the list roles, machines left out (they are attached in the Machines view). */
export function shippedPlugins(report: PluginsReport): ShippedPlugin[] {
  return report.plugins.flatMap((p): ShippedPlugin[] => {
    if (!p.builtin || !isListRole(p.role) || p.role === 'machine-source') return [];
    const instances = report.instances.filter((i) => i.role === p.role && i.instance.plugin === p.id).map((i) => i.instance.name);
    const enabled = instances.length > 0;
    const blocked = enabled
      ? (instances.length > 1 ? `${instances.length} instances: remove them below` : undefined)
      : p.detection.status !== 'available'
        ? (p.detection.reason ?? p.detection.status)
        : machineOptions(p.options as OptionsSchema).length
          ? `runs on a machine: add it under ${ROLE_TITLES[p.role]}, picking the machine`
          : newInstance(report, p.role, p.id, '').problem;
    return [{ id: p.id, role: p.role, describe: p.describe, enabled, instances, ...(blocked ? { blocked } : {}) }];
  });
}

/** What flipping the switch sends: add one instance under the plugin's id, or remove its one instance; null when blocked. */
export function toggleEdit(report: PluginsReport, p: ShippedPlugin): Extract<PluginsEdit, { action: 'add' | 'remove' }> | null {
  if (p.blocked) return null;
  const version = report.config.version;
  return p.enabled
    ? { action: 'remove', role: p.role, name: p.instances[0]!, version }
    : { action: 'add', role: p.role, plugin: p.id, name: p.id, version };
}
