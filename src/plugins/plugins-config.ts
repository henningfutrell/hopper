// The plugins config: which instance fills which role (design.md "Configuration — the plugins
// config"), the config record `plugins` in the store (design.md "Config in the database"). Read:
// router, queueSorter, escalationLevels, executors, jobSources, machines (this machine and the
// attached ones, issue #74), usageSources, notifiers, routing, machineDefaults. A UI edit (edit.ts,
// attached-edit.ts) replaces it against its version.
import { z } from 'zod';
import { isModelName } from '../domain/plugins.ts';
import type { InstanceSpec, MachineDefaults, RoutingRule } from '../domain/types.ts';
import { ROUTING_RULES } from '../routing/index.ts';

export type PluginsConfigResult =
  | { missing: true }
  /** `escalationLevels: []` = no levels (questions go straight to the owner); absent = the built-in ones. */
  | {
    router?: InstanceSpec; queueSorter?: InstanceSpec; escalationLevels?: InstanceSpec[]; executors?: InstanceSpec[];
    jobSources?: InstanceSpec[]; machines?: InstanceSpec[]; usageSources?: InstanceSpec[]; notifiers?: InstanceSpec[];
    routing?: RoutingRule[]; machineDefaults?: Partial<MachineDefaults>; warnings: string[];
  }
  | { error: string };

const instance = z.strictObject({
  name: z.string().min(1),
  plugin: z.string().min(1),
  options: z.record(z.string(), z.unknown()).default({}),
});

/** Instances under unique names: `what` names the thing that is keyed by the name. */
const uniqueList = (section: string, keyedBy: string) => z.array(instance).superRefine((list, ctx) => {
  const seen = new Set<string>();
  for (const e of list) {
    if (seen.has(e.name)) ctx.addIssue({ code: 'custom', message: `${section}: ${e.name} named twice; ${keyedBy}` });
    seen.add(e.name);
  }
});

const CONFIG = z.strictObject({
  version: z.literal(1),
  router: instance.optional(),
  queueSorter: instance.optional(),
  // 0..n, lowest first; a level's name is also a question stage, so it is one level and never `human`.
  // It names the level, not a model (issue #209): the model is only its `model` option.
  escalationLevels: uniqueList('escalationLevels', 'a question stage names its level').superRefine((list, ctx) => {
    if (list.some((e) => e.name === 'human')) ctx.addIssue({ code: 'custom', message: 'escalationLevels: human is the human stage; name the level something else' });
    for (const e of list.filter((l) => isModelName(l.name, l.options.model))) {
      ctx.addIssue({ code: 'custom', message: `escalationLevels: ${e.name} is a model name; name the level as a level (its model is its model option)` });
    }
  }).optional(),
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
  // What a machine attached from the UI starts with (issue #142); a field left out: the ssh plugin's default.
  machineDefaults: z.strictObject({
    lanes: z.number().int().min(1, 'machineDefaults.lanes must be at least 1').optional(),
    executors: z.array(z.string().min(1)).optional(),
  }).optional(),
});

/** Why a plugins config is refused, or undefined when it is valid. */
export function pluginsConfigProblem(raw: unknown): string | undefined {
  const parsed = CONFIG.safeParse(raw);
  return parsed.success ? undefined : parsed.error.issues.map((i) => `${i.path.join('.') || '(config)'}: ${i.message}`).join('; ');
}

/** The config record that holds it. */
export const PLUGINS = 'plugins';

/** The plugins config checked; `undefined`: there is none yet. */
export function loadPluginsConfig(raw: unknown): PluginsConfigResult {
  if (raw === undefined) return { missing: true };
  const parsed = CONFIG.safeParse(raw);
  if (!parsed.success) return { error: `the plugins config: ${pluginsConfigProblem(raw)}` };
  const warnings: string[] = [];
  const { router, queueSorter, escalationLevels, executors, jobSources, machines, usageSources, notifiers, routing, machineDefaults } = parsed.data;
  return {
    ...(router ? { router } : {}),
    ...(queueSorter ? { queueSorter } : {}),
    ...(escalationLevels ? { escalationLevels } : {}),
    ...(executors ? { executors } : {}),
    ...(jobSources ? { jobSources } : {}),
    ...(machines ? { machines } : {}),
    ...(usageSources ? { usageSources } : {}),
    ...(notifiers ? { notifiers } : {}),
    ...(routing ? { routing } : {}),
    ...(machineDefaults ? { machineDefaults } : {}),
    warnings,
  };
}
