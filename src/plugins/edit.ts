// A UI edit of plugins.yaml (design.md "UI and mutation"): one instance's options, the plugin
// filling a one-instance role, or an instance of a list role added or removed. Each edit rewrites only that instance's part of the file; comments
// and every other section stay as written. Command-bearing options are never changed from here.
import { isMap, isSeq, parseDocument, type Document } from 'yaml';
import type { ConfiguredInstance, Detection, InstanceSpec, ListRole, PluginsEdit, Role, RoutingEdit, RoutingRule } from '../domain/types.ts';
import { parseRoutingRules } from '../routing/index.ts';
import { optionsJsonSchema, parseOptions } from './options.ts';
import { pluginsFileProblem, pluginsFileVersion, readPluginsText, writePluginsFile } from './plugins-file.ts';
import type { PluginDefinition } from './sdk.ts';

export type EditRefusal = { ok: false; code: 'invalid' | 'not_found' | 'conflict'; error: string };
export type EditResult = { ok: true; changed: boolean } | EditRefusal;

export interface EditContext {
  path: string;
  /** What plugins.yaml (or the built-in instances, for a role with no section) names now. */
  configured: readonly ConfiguredInstance[];
  find(id: string): { definition: PluginDefinition; detection: Detection } | undefined;
}

/** Where each role's instances live in plugins.yaml. */
const SECTIONS: Record<Role, { key: string; many: boolean }> = {
  router: { key: 'router', many: false },
  'queue-sorter': { key: 'queueSorter', many: false },
  answerer: { key: 'answerer', many: false },
  assessor: { key: 'assessor', many: false },
  executor: { key: 'executors', many: true },
  'job-source': { key: 'jobSources', many: true },
  'machine-source': { key: 'machines', many: false },
  'usage-source': { key: 'usageSources', many: true },
  notifier: { key: 'notifiers', many: true },
};

/** What plugins.yaml (or the built-in instances) names now, section by section. */
export interface Configured {
  router?: InstanceSpec; queueSorter: InstanceSpec; answerer: InstanceSpec | null; assessor: InstanceSpec; executors: InstanceSpec[];
  jobSources: InstanceSpec[]; machines: InstanceSpec; usageSources: InstanceSpec[]; notifiers: InstanceSpec[];
  /** plugins.yaml `routing:`, in order; absent: none. */
  routing: RoutingRule[];
}

/** Every configured instance by role; with no `router` section, the router chosen by detection. */
export function configuredInstances(c: Configured, detectedRouter: InstanceSpec): ConfiguredInstance[] {
  return [
    { role: 'router', instance: c.router ?? detectedRouter },
    { role: 'queue-sorter', instance: c.queueSorter },
    ...(c.answerer ? [{ role: 'answerer' as const, instance: c.answerer }] : []),
    { role: 'assessor', instance: c.assessor },
    ...c.executors.map((instance) => ({ role: 'executor' as const, instance })),
    ...c.jobSources.map((instance) => ({ role: 'job-source' as const, instance })),
    { role: 'machine-source', instance: c.machines },
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

/** Command-bearing keys whose value would change, each side parsed with the plugin's schema. */
function changedCommandBearing(def: PluginDefinition, before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const a = parseOptions(def, before);
  const b = parseOptions(def, after);
  const was = a.ok ? a.options : before;
  const now = b.ok ? b.options : after;
  return commandBearingKeys(def).filter((k) => JSON.stringify(was[k]) !== JSON.stringify(now[k]));
}

function specNode(spec: InstanceSpec): Record<string, unknown> {
  return { name: spec.name, plugin: spec.plugin, ...(spec.options && Object.keys(spec.options).length ? { options: spec.options } : {}) };
}

/** Put `next` in place of the configured instance `name` of `role`, touching nothing else. */
function place(doc: Document, role: Role, name: string, next: InstanceSpec | null, configured: readonly ConfiguredInstance[]): void {
  const { key, many } = SECTIONS[role];
  const section = doc.get(key, true);
  if (!many) {
    if (next && isMap(section) && section.get('plugin') === next.plugin && section.get('name') === next.name) {
      doc.setIn([key, 'options'], doc.createNode(next.options ?? {}));
    } else {
      doc.set(key, next === null ? null : doc.createNode(specNode(next)));
    }
    return;
  }
  if (isSeq(section) && next) {
    const at = section.items.findIndex((item) => isMap(item) && item.get('name') === name);
    if (at >= 0) {
      doc.setIn([key, at, 'options'], doc.createNode(next.options ?? {}));
      return;
    }
  }
  // No section yet: the built-in instances fill this role; write them all, this one changed.
  const all = configured.filter((c) => c.role === role).map((c) => (c.instance.name === name && next ? next : c.instance));
  doc.set(key, doc.createNode(all.map(specNode)));
}

/** Append `next` to a list role, or remove instance `name` from it (`next` null); nothing else changes. */
function list(doc: Document, role: ListRole, name: string, next: InstanceSpec | null, configured: readonly ConfiguredInstance[]): void {
  const { key } = SECTIONS[role];
  const section = doc.get(key, true);
  if (isSeq(section)) {
    if (next) {
      const node = doc.createNode(specNode(next));
      // Written like the entry before it: one flow line when that one is.
      const last = section.items.at(-1);
      if (isMap(node) && isMap(last)) node.flow = last.flow ?? false;
      section.add(node);
    } else {
      section.items.splice(section.items.findIndex((item) => isMap(item) && item.get('name') === name), 1);
    }
    return;
  }
  // No section yet: the built-in instances fill this role; write them, with this change.
  const now = configured.filter((c) => c.role === role).map((c) => c.instance).filter((i) => next || i.name !== name);
  doc.set(key, doc.createNode([...now, ...(next ? [next] : [])].map(specNode)));
}

/**
 * What still names executor `name` in the file as it is now: job sources (their `executor`, the
 * plugin's default when unset; no section: the built-in ones), routing rules, attached machines.
 */
function executorUsers(name: string, doc: Document, ctx: EditContext): string[] {
  const file = (doc.toJS() ?? {}) as { jobSources?: InstanceSpec[]; routing?: RoutingRule[]; attachedMachines?: { name: string; executors?: string[] }[] };
  const sources = file.jobSources ?? ctx.configured.filter((c) => c.role === 'job-source').map((c) => c.instance);
  const named = sources.filter((i) => {
    const def = ctx.find(i.plugin)?.definition;
    const parsed = def ? parseOptions(def, i.options ?? {}) : undefined;
    return (parsed?.ok ? parsed.options : (i.options ?? {})).executor === name;
  });
  return [
    ...named.map((i) => `job source ${i.name}`),
    ...(file.routing ?? []).filter((r) => r.set?.executor === name).map((r) => `routing rule ${r.name}`),
    ...(file.attachedMachines ?? []).filter((m) => (m.executors ?? ['herdr-claude']).includes(name)).map((m) => `attached machine ${m.name}`),
  ];
}

function write(path: string, text: string | undefined, version: string, change: (doc: Document) => EditRefusal | void): EditResult {
  if (pluginsFileVersion(text) !== version) return refuse('conflict', `${path} changed since it was read; reload and edit again`);
  const doc = text === undefined ? parseDocument('version: 1\n') : parseDocument(text);
  if (doc.errors.length) return refuse('conflict', `${path} is not valid YAML; fix it by hand: ${doc.errors[0]!.message}`);
  const before = pluginsFileProblem(doc.toJS());
  if (before) return refuse('conflict', `${path} is invalid; fix it by hand: ${before}`);
  const refused = change(doc);
  if (refused) return refused;
  const problem = pluginsFileProblem(doc.toJS());
  if (problem) return refuse('invalid', problem);
  // lineWidth 0: never refold lines the owner wrote long.
  writePluginsFile(path, doc.toString({ lineWidth: 0 }));
  return { ok: true, changed: true };
}

/**
 * POST /ui/api/routing (design.md "Routing rules (issue #18)"): the whole ordered list replaces the
 * `routing` node; nothing else in the file changes. `targetProblem`: why a rule names a machine or
 * executor that is not configured, refused like an invalid rule.
 */
export function applyRoutingEdit(e: RoutingEdit, path: string, targetProblem: (rules: RoutingRule[]) => string | undefined): EditResult {
  const parsed = parseRoutingRules(e.rules);
  if (!parsed.ok) return refuse('invalid', parsed.error);
  const problem = targetProblem(parsed.rules);
  if (problem) return refuse('invalid', problem);
  return write(path, readPluginsText(path), e.version, (doc) => { doc.set('routing', doc.createNode(parsed.rules)); });
}

export function applyEdit(e: Exclude<PluginsEdit, { action: 'rescan' }>, ctx: EditContext): EditResult {
  const text = readPluginsText(ctx.path);
  if (e.action === 'add' || e.action === 'remove') return applyListEdit(e, text, ctx);
  if (e.action === 'options') {
    const current = ctx.configured.find((c) => c.role === e.role && c.instance.name === e.name);
    if (!current) return refuse('not_found', `no ${e.role} instance named ${e.name}`);
    const def = ctx.find(current.instance.plugin)?.definition;
    if (!def) return refuse('conflict', `plugin ${current.instance.plugin} is not loaded; edit ${e.name} in ${ctx.path}`);
    const parsed = parseOptions(def, e.options);
    if (!parsed.ok) return refuse('invalid', parsed.error);
    const changed = changedCommandBearing(def, current.instance.options ?? {}, e.options);
    if (changed.length) {
      return refuse('conflict', `${changed.join(', ')} ${changed.length === 1 ? 'is' : 'are'} command-bearing: edit ${changed.length === 1 ? 'it' : 'them'} in ${ctx.path}, not from the UI`);
    }
    const next = { ...current.instance, options: e.options };
    return write(ctx.path, text, e.version, (doc) => place(doc, e.role, e.name, next, ctx.configured));
  }

  const current = ctx.configured.find((c) => c.role === e.role);
  if (e.plugin === null) {
    if (e.role !== 'answerer') return refuse('invalid', `the ${e.role} is never empty; select a plugin`);
    if (!current) return { ok: true, changed: false };
    return write(ctx.path, text, e.version, (doc) => place(doc, 'answerer', current.instance.name, null, ctx.configured));
  }
  const found = ctx.find(e.plugin);
  if (!found) return refuse('not_found', `no plugin ${e.plugin}`);
  if (found.definition.role !== e.role) return refuse('conflict', `${e.plugin} is a ${found.definition.role} plugin, not a ${e.role} plugin`);
  if (found.detection.status !== 'available') {
    return refuse('conflict', `${e.plugin} is ${found.detection.status} here: ${found.detection.reason}`);
  }
  if (current?.instance.plugin === e.plugin) return { ok: true, changed: false };
  return write(ctx.path, text, e.version, (doc) => place(doc, e.role, current?.instance.name ?? e.plugin!, { name: e.plugin!, plugin: e.plugin! }, ctx.configured));
}

function applyListEdit(e: Extract<PluginsEdit, { action: 'add' | 'remove' }>, text: string | undefined, ctx: EditContext): EditResult {
  const current = ctx.configured.find((c) => c.role === e.role && c.instance.name === e.name);
  if (e.action === 'remove') {
    if (!current) return refuse('not_found', `no ${e.role} instance named ${e.name}`);
    return write(ctx.path, text, e.version, (doc) => {
      const users = e.role === 'executor' ? executorUsers(e.name, doc, ctx) : [];
      if (users.length) return refuse('conflict', `executor ${e.name} is named by ${users.join(', ')}; change ${users.length === 1 ? 'it' : 'them'} first`);
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
  return write(ctx.path, text, e.version, (doc) => list(doc, e.role, e.name, { name: e.name, plugin: e.plugin }, ctx.configured));
}
