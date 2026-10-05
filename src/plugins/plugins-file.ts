// plugins.yaml: which instance fills which role (design.md "Configuration — plugins.yaml"), a config
// document in the store (design.md "Config documents"). Read: router, queueSorter, answerer,
// assessor, executors, jobSources, machines (this machine and the attached ones, issue #74),
// usageSources, notifiers, routing. A UI edit (edit.ts, attached-edit.ts) replaces it against its version.
import { parse } from 'yaml';
import { z } from 'zod';
import type { InstanceSpec, RoutingRule } from '../domain/types.ts';
import { ROUTING_RULES } from '../routing/index.ts';

export type PluginsFileResult =
  | { missing: true }
  /** `answerer: null` = no answerer configured; absent = derive it. */
  | {
    router?: InstanceSpec; queueSorter?: InstanceSpec; answerer?: InstanceSpec | null; assessor?: InstanceSpec; executors?: InstanceSpec[];
    jobSources?: InstanceSpec[]; machines?: InstanceSpec[]; usageSources?: InstanceSpec[]; notifiers?: InstanceSpec[];
    routing?: RoutingRule[]; warnings: string[];
  }
  | { error: string };

const instance = z.strictObject({
  name: z.string().min(1),
  plugin: z.string().min(1),
  options: z.record(z.string(), z.unknown()).default({}),
});

/** A question role's instance name is also a question stage, so `human` is taken. */
const stageInstance = instance.extend({
  name: z.string().min(1).refine((n) => n !== 'human', 'human is the human stage; name the instance something else'),
});

/** Instances under unique names: `what` names the thing that is keyed by the name. */
const uniqueList = (section: string, keyedBy: string) => z.array(instance).superRefine((list, ctx) => {
  const seen = new Set<string>();
  for (const e of list) {
    if (seen.has(e.name)) ctx.addIssue({ code: 'custom', message: `${section}: ${e.name} named twice; ${keyedBy}` });
    seen.add(e.name);
  }
});

const FILE = z.strictObject({
  version: z.literal(1),
  router: instance.optional(),
  queueSorter: instance.optional(),
  answerer: stageInstance.nullable().optional(),
  assessor: stageInstance.optional(),
  // 1..n; jobs name an executor instance, so a name is one instance.
  executors: uniqueList('executors', 'jobs name their executor').min(1, 'name at least one executor').optional(),
  // 0..n each; a job source's name keys its jobs and sync state.
  jobSources: uniqueList('jobSources', 'jobs and sync state are keyed by it').optional(),
  // 0..n: this machine and the attached ones (issue #74); lanes and jobs are stored under a machine's name.
  machines: uniqueList('machines', 'lanes and jobs are stored under it').optional(),
  usageSources: uniqueList('usageSources', 'readings name their source').optional(),
  notifiers: uniqueList('notifiers', 'logs and /api/plugins name a notifier by it').optional(),
  // Routing rules, in order (issue #18); absent: none.
  routing: ROUTING_RULES.optional(),
}).refine((f) => !f.answerer || !f.assessor || f.answerer.name !== f.assessor.name, {
  message: 'answerer and assessor have the same name; a question stage must say which one holds it',
  path: ['assessor', 'name'],
});

/** Why a parsed plugins.yaml is refused, or undefined when it is valid. */
export function pluginsFileProblem(raw: unknown): string | undefined {
  const parsed = FILE.safeParse(raw);
  return parsed.success ? undefined : parsed.error.issues.map((i) => `${i.path.join('.') || 'file'}: ${i.message}`).join('; ');
}

export const PLUGINS = 'plugins.yaml';

/** How the operator edits a config document by hand: the CLI against the same database (design.md "Config documents"). */
export const BY_HAND = 'hopper config edit plugins.yaml';

/** The plugins document's text parsed and checked; `undefined` text: there is none yet. */
export function loadPluginsFile(text: string | undefined): PluginsFileResult {
  if (text === undefined) return { missing: true };
  let raw: unknown;
  try { raw = parse(text); } catch (e) { return { error: `${PLUGINS}: ${(e as Error).message}` }; }
  const parsed = FILE.safeParse(raw);
  if (!parsed.success) return { error: `${PLUGINS}: ${pluginsFileProblem(raw)}` };
  const warnings: string[] = [];
  const { router, queueSorter, answerer, assessor, executors, jobSources, machines, usageSources, notifiers, routing } = parsed.data;
  return {
    ...(router ? { router } : {}),
    ...(queueSorter ? { queueSorter } : {}),
    ...(answerer !== undefined ? { answerer } : {}),
    ...(assessor ? { assessor } : {}),
    ...(executors ? { executors } : {}),
    ...(jobSources ? { jobSources } : {}),
    ...(machines ? { machines } : {}),
    ...(usageSources ? { usageSources } : {}),
    ...(notifiers ? { notifiers } : {}),
    ...(routing ? { routing } : {}),
    warnings,
  };
}
