// A UI edit of the plugins config (design.md "UI and mutation", issue #198): one instance's options —
// every one of them, command-bearing ones too —, the plugin filling a one-instance role, an instance of
// a list role added or removed, or an escalation level moved. Each edit changes only that instance's
// part of the config record and is written against the version it was read at.
import type { ConfigRecords } from '../domain/ports.ts';
import type { ConfiguredInstance, Detection, InstanceSpec, ListRole, MachineDefaults, PluginsEdit, Role, RoutingEdit, RoutingRule } from '../domain/types.ts';
import { parseRoutingRules } from '../routing/index.ts';
import { machineOptions, optionsJsonSchema, parseOptions } from './options.ts';
import { PLUGINS, pluginsConfigProblem } from './plugins-config.ts';
import type { PluginDefinition } from './sdk.ts';

export type EditRefusal = { ok: false; code: 'invalid' | 'not_found' | 'conflict'; error: string };
export type EditResult = { ok: true; changed: boolean } | EditRefusal;

export interface EditContext {
  config: ConfigRecords;
  /**
   * Jobs that need instance `name` of `role` — a machine (busy lanes there, panes parked there) or an
   * executor (a job naming it that has not ended, issue #142): its removal is refused while any do.
   */
  inUse(role: Role, name: string): string[];
  /** What the plugins config (or the built-in instances, for a role with no section) names now. */
  configured: readonly ConfiguredInstance[];
  find(id: string): { definition: PluginDefinition; detection: Detection } | undefined;
}

/** Where each role's instances live in the plugins config. */
const SECTIONS: Record<Role, { key: string; many: boolean }> = {
  router: { key: 'router', many: false },
  'queue-sorter': { key: 'queueSorter', many: false },
  'escalation-level': { key: 'escalationLevels', many: true },
  executor: { key: 'executors', many: true },
  'job-source': { key: 'jobSources', many: true },
  'machine-source': { key: 'machines', many: true },
  'usage-source': { key: 'usageSources', many: true },
  notifier: { key: 'notifiers', many: true },
};

/** What the plugins config (or the built-in instances) names now, section by section. */
export interface Configured {
  router?: InstanceSpec; queueSorter: InstanceSpec; escalationLevels: InstanceSpec[]; executors: InstanceSpec[];
  jobSources: InstanceSpec[]; machines: InstanceSpec[]; usageSources: InstanceSpec[]; notifiers: InstanceSpec[];
  /** `routing`, in order; absent: none. */
  routing: RoutingRule[];
  /** `machineDefaults`; absent: none set. */
  machineDefaults: Partial<MachineDefaults>;
}

/** Every configured instance by role; with no `router` section, the router chosen by detection. */
export function configuredInstances(c: Configured, detectedRouter: InstanceSpec): ConfiguredInstance[] {
  return [
    { role: 'router', instance: c.router ?? detectedRouter },
    { role: 'queue-sorter', instance: c.queueSorter },
    ...c.escalationLevels.map((instance) => ({ role: 'escalation-level' as const, instance })),
    ...c.executors.map((instance) => ({ role: 'executor' as const, instance })),
    ...c.jobSources.map((instance) => ({ role: 'job-source' as const, instance })),
    ...c.machines.map((instance) => ({ role: 'machine-source' as const, instance })),
    ...c.usageSources.map((instance) => ({ role: 'usage-source' as const, instance })),
    ...c.notifiers.map((instance) => ({ role: 'notifier' as const, instance })),
  ];
}

const refuse = (code: EditRefusal['code'], error: string): EditRefusal => ({ ok: false, code, error });

/** The options marked `.meta({ commandBearing: true })` in the plugin's schema. */
export function commandBearingKeys(def: PluginDefinition): string[] {
  const props = optionsJsonSchema(def).properties;
  if (!props || typeof props !== 'object') return [];
  return Object.entries(props as Record<string, { commandBearing?: unknown }>).filter(([, p]) => p?.commandBearing === true).map(([k]) => k);
}

function specNode(spec: InstanceSpec): Record<string, unknown> {
  return { name: spec.name, plugin: spec.plugin, ...(spec.options && Object.keys(spec.options).length ? { options: spec.options } : {}) };
}

/** The plugins config as edited: a plain object, a section an array (a list role) or one instance. */
type Plugins = Record<string, unknown>;

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isInstance = (x: unknown): x is InstanceSpec => isObject(x);

/** Put `next` in place of the configured instance `name` of `role`, touching nothing else. */
function place(doc: Plugins, role: Role, name: string, next: InstanceSpec, configured: readonly ConfiguredInstance[]): void {
  const { key, many } = SECTIONS[role];
  const section = doc[key];
  if (!many) {
    doc[key] = isInstance(section) && section.plugin === next.plugin && section.name === next.name
      ? { ...section, options: next.options ?? {} }
      : specNode(next);
    return;
  }
  if (Array.isArray(section)) {
    const at = section.findIndex((item) => isInstance(item) && item.name === name);
    if (at >= 0) {
      section[at] = { ...(section[at] as InstanceSpec), options: next.options ?? {} };
      return;
    }
  }
  // No section yet: the built-in instances fill this role; write them all, this one changed.
  doc[key] = configured.filter((c) => c.role === role).map((c) => specNode(c.instance.name === name ? next : c.instance));
}

/** Append `next` to a list role, or remove instance `name` from it (`next` null); nothing else changes. */
export function list(doc: Plugins, role: ListRole, name: string, next: InstanceSpec | null, configured: readonly ConfiguredInstance[]): void {
  const { key } = SECTIONS[role];
  const section = doc[key];
  if (Array.isArray(section)) {
    doc[key] = next ? [...section, specNode(next)] : section.filter((item) => !(isInstance(item) && item.name === name));
    return;
  }
  // No section yet: the built-in instances fill this role; write them, with this change.
  const now = configured.filter((c) => c.role === role).map((c) => c.instance).filter((i) => next || i.name !== name);
  doc[key] = [...now, ...(next ? [next] : [])].map(specNode);
}

/** Move escalation level `name` to position `to` (clamped); every other entry keeps its order. */
function move(doc: Plugins, name: string, to: number, configured: readonly ConfiguredInstance[]): void {
  const { key } = SECTIONS['escalation-level'];
  // No section yet: the built-in levels fill the role; write them, so there is an order to change.
  const section = Array.isArray(doc[key]) ? [...doc[key] as unknown[]] : configured.filter((c) => c.role === 'escalation-level').map((c) => specNode(c.instance));
  const from = section.findIndex((item) => isInstance(item) && item.name === name);
  const [entry] = section.splice(from, 1);
  section.splice(Math.max(0, Math.min(to, section.length)), 0, entry);
  doc[key] = section;
}

/**
 * What still names executor `name` in the plugins config as it is now: job sources (their `executor`), machines
 * (their `executors`; absent on a `local` instance: every one, which names none) — each option the
 * plugin's default when unset, a section absent: the built-in instances — and routing rules.
 */
function executorUsers(name: string, doc: Plugins, ctx: EditContext): string[] {
  const file = doc as { jobSources?: InstanceSpec[]; machines?: InstanceSpec[]; routing?: RoutingRule[] };
  const options = (i: InstanceSpec): Record<string, unknown> => {
    const def = ctx.find(i.plugin)?.definition;
    const parsed = def ? parseOptions(def, i.options ?? {}) : undefined;
    return parsed?.ok ? parsed.options : (i.options ?? {});
  };
  const section = (role: Role, key: 'jobSources' | 'machines') => file[key] ?? ctx.configured.filter((c) => c.role === role).map((c) => c.instance);
  return [
    ...section('job-source', 'jobSources').filter((i) => options(i).executor === name).map((i) => `job source ${i.name}`),
    ...section('machine-source', 'machines').filter((i) => { const x = options(i).executors; return Array.isArray(x) && x.includes(name); }).map((i) => `machine ${i.name}`),
    ...(file.routing ?? []).filter((r) => r.set?.executor === name).map((r) => `routing rule ${r.name}`),
  ];
}

/**
 * Why `options` do not name a configured machine in every machine option of `def` (issue #174): a
 * machine is always named, and only one the machine sources list. Undefined when they do.
 */
function machineProblem(def: PluginDefinition, options: Record<string, unknown>, ctx: EditContext): string | undefined {
  const known = ctx.configured.filter((c) => c.role === 'machine-source').map((c) => c.instance.name);
  const pick = known.length ? `pick one of ${known.join(', ')}` : 'attach one first';
  for (const key of machineOptions(def)) {
    const v = options[key];
    if (v === undefined || v === '') return `${def.id} runs on a machine: ${pick}`;
    if (typeof v !== 'string' || !known.includes(v)) return `${key}: machine ${String(v)} is not a configured machine: ${pick}`;
  }
  return undefined;
}

/** What still names machine `name` in a machine option (issue #174): escalation levels, usage sources, any instance of a plugin with one. */
function machineUsers(name: string, ctx: EditContext): string[] {
  return ctx.configured.filter(({ instance }) => {
    const def = ctx.find(instance.plugin)?.definition;
    return def !== undefined && machineOptions(def).some((k) => instance.options?.[k] === name);
  }).map(({ role, instance }) => `${role} ${instance.name}`);
}

const CHANGED = 'the plugins config changed since it was read; reload and edit again';

/**
 * Apply `change` to the plugins config read now, and replace it if it is still at `version`. The
 * result must be a valid plugins config; what was stored before need not be, so an edit can mend it.
 */
export function writePlugins(config: ConfigRecords, version: string, change: (doc: Plugins) => EditRefusal | void): EditResult {
  const value = config.read(PLUGINS);
  if (config.version(PLUGINS) !== version) return refuse('conflict', CHANGED);
  const doc: Plugins = isObject(value) ? structuredClone(value) : { version: 1 };
  const refused = change(doc);
  if (refused) return refused;
  const problem = pluginsConfigProblem(doc);
  if (problem) return refuse('invalid', problem);
  if (!config.write(PLUGINS, doc, version)) return refuse('conflict', CHANGED);
  return { ok: true, changed: true };
}

/**
 * POST /ui/api/routing (design.md "Routing rules (issue #18)"): the whole ordered list replaces the
 * `routing` section; nothing else changes. `targetProblem`: why a rule names a machine or
 * executor that is not configured, refused like an invalid rule.
 */
export function applyRoutingEdit(e: RoutingEdit, config: ConfigRecords, targetProblem: (rules: RoutingRule[]) => string | undefined): EditResult {
  const parsed = parseRoutingRules(e.rules);
  if (!parsed.ok) return refuse('invalid', parsed.error);
  const problem = targetProblem(parsed.rules);
  if (problem) return refuse('invalid', problem);
  return writePlugins(config, e.version, (doc) => { doc.routing = parsed.rules; });
}

export function applyEdit(e: Exclude<PluginsEdit, { action: 'rescan' }>, ctx: EditContext): EditResult {
  if (e.action === 'add' || e.action === 'remove') return applyListEdit(e, ctx);
  if (e.action === 'move') {
    const levels = ctx.configured.filter((c) => c.role === 'escalation-level');
    const at = levels.findIndex((c) => c.instance.name === e.name);
    if (at < 0) return refuse('not_found', `no escalation-level instance named ${e.name}`);
    if (!Number.isInteger(e.to) || e.to < 0 || e.to >= levels.length) return refuse('invalid', `to must be a position from 0 to ${levels.length - 1}`);
    if (at === e.to) return { ok: true, changed: false };
    return writePlugins(ctx.config, e.version, (doc) => move(doc, e.name, e.to, ctx.configured));
  }
  if (e.action === 'options') {
    const current = ctx.configured.find((c) => c.role === e.role && c.instance.name === e.name);
    if (!current) return refuse('not_found', `no ${e.role} instance named ${e.name}`);
    const def = ctx.find(current.instance.plugin)?.definition;
    if (!def) return refuse('conflict', `plugin ${current.instance.plugin} is not loaded: its options cannot be checked; install it again, or remove ${e.name}`);
    const noMachine = machineProblem(def, e.options, ctx);
    if (noMachine) return refuse('invalid', noMachine);
    const parsed = parseOptions(def, e.options);
    if (!parsed.ok) return refuse('invalid', parsed.error);
    const next = { ...current.instance, options: e.options };
    return writePlugins(ctx.config, e.version, (doc) => place(doc, e.role, e.name, next, ctx.configured));
  }

  const current = ctx.configured.find((c) => c.role === e.role);
  const found = ctx.find(e.plugin);
  if (!found) return refuse('not_found', `no plugin ${e.plugin}`);
  if (found.definition.role !== e.role) return refuse('conflict', `${e.plugin} is a ${found.definition.role} plugin, not a ${e.role} plugin`);
  if (found.detection.status !== 'available') {
    return refuse('conflict', `${e.plugin} is ${found.detection.status} here: ${found.detection.reason}`);
  }
  if (current?.instance.plugin === e.plugin) return { ok: true, changed: false };
  return writePlugins(ctx.config, e.version, (doc) => place(doc, e.role, current?.instance.name ?? e.plugin, { name: e.plugin, plugin: e.plugin }, ctx.configured));
}

function applyListEdit(e: Extract<PluginsEdit, { action: 'add' | 'remove' }>, ctx: EditContext): EditResult {
  const current = ctx.configured.find((c) => c.role === e.role && c.instance.name === e.name);
  if (e.action === 'remove') {
    if (!current) return refuse('not_found', `no ${e.role} instance named ${e.name}`);
    const jobs = ctx.inUse(e.role, e.name);
    if (jobs.length) return refuse('conflict', `${e.name} still has jobs (${jobs.join(', ')}): wait for them to end, or cancel them, then remove it`);
    return writePlugins(ctx.config, e.version, (doc) => {
      const users = e.role === 'executor' ? executorUsers(e.name, doc, ctx) : e.role === 'machine-source' ? machineUsers(e.name, ctx) : [];
      if (users.length) return refuse('conflict', `${e.role === 'executor' ? 'executor' : 'machine'} ${e.name} is named by ${users.join(', ')}; change ${users.length === 1 ? 'it' : 'them'} first`);
      list(doc, e.role, e.name, null, ctx.configured);
      return undefined;
    });
  }
  if (current) return refuse('conflict', `a ${e.role} instance is already named ${e.name}`);
  const found = ctx.find(e.plugin);
  if (!found) return refuse('not_found', `no plugin ${e.plugin}`);
  if (found.definition.role !== e.role) return refuse('conflict', `${e.plugin} is a ${found.definition.role} plugin, not a ${e.role} plugin`);
  if (found.detection.status !== 'available') {
    return refuse('conflict', `${e.plugin} is ${found.detection.status} here: ${found.detection.reason}`);
  }
  const noMachine = machineProblem(found.definition, e.options ?? {}, ctx);
  if (noMachine) return refuse('invalid', noMachine);
  if (e.options) {
    const parsed = parseOptions(found.definition, e.options);
    if (!parsed.ok) return refuse('invalid', parsed.error);
  }
  return writePlugins(ctx.config, e.version, (doc) => list(doc, e.role, e.name, { name: e.name, plugin: e.plugin, ...(e.options ? { options: e.options } : {}) }, ctx.configured));
}
