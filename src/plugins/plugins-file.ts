// plugins.yaml: which instance fills which role (design.md "Configuration — plugins.yaml"). Read:
// router, answerer, assessor, executors, jobSources, machines, usageSources, notifiers.
import { readFileSync, statSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import type { InstanceSpec } from '../domain/types.ts';

export type PluginsFileResult =
  | { missing: true }
  /** `answerer: null` = no answerer configured; absent = derive it. */
  | {
    router?: InstanceSpec; answerer?: InstanceSpec | null; assessor?: InstanceSpec; executors?: InstanceSpec[];
    jobSources?: InstanceSpec[]; machines?: InstanceSpec; usageSources?: InstanceSpec[]; notifiers?: InstanceSpec[];
    warnings: string[];
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
  answerer: stageInstance.nullable().optional(),
  assessor: stageInstance.optional(),
  // 1..n; jobs name an executor instance, so a name is one instance.
  executors: uniqueList('executors', 'jobs name their executor').min(1, 'name at least one executor').optional(),
  // 0..n each; a job source's name keys its jobs and sync state.
  jobSources: uniqueList('jobSources', 'jobs and sync state are keyed by it').optional(),
  machines: instance.optional(),
  usageSources: uniqueList('usageSources', 'readings name their source').optional(),
  notifiers: uniqueList('notifiers', 'logs and /api/plugins name a notifier by it').optional(),
}).refine((f) => !f.answerer || !f.assessor || f.answerer.name !== f.assessor.name, {
  message: 'answerer and assessor have the same name; a question stage must say which one holds it',
  path: ['assessor', 'name'],
});

export function loadPluginsFile(path: string): PluginsFileResult {
  let text: string;
  let mode: number;
  try {
    text = readFileSync(path, 'utf8');
    mode = statSync(path).mode;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { missing: true };
    return { error: `cannot read ${path}: ${(e as Error).message}` };
  }
  let raw: unknown;
  try { raw = parse(text); } catch (e) { return { error: `${path}: ${(e as Error).message}` }; }
  const parsed = FILE.safeParse(raw);
  if (!parsed.success) {
    return { error: `${path}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'file'}: ${i.message}`).join('; ')}` };
  }
  const warnings = mode & 0o077 ? [`${path} is readable by group/other; options may hold secrets (chmod 600 ${path})`] : [];
  const { router, answerer, assessor, executors, jobSources, machines, usageSources, notifiers } = parsed.data;
  return {
    ...(router ? { router } : {}),
    ...(answerer !== undefined ? { answerer } : {}),
    ...(assessor ? { assessor } : {}),
    ...(executors ? { executors } : {}),
    ...(jobSources ? { jobSources } : {}),
    ...(machines ? { machines } : {}),
    ...(usageSources ? { usageSources } : {}),
    ...(notifiers ? { notifiers } : {}),
    warnings,
  };
}
