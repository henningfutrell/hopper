// plugins.yaml: which instance fills which role (design.md "Configuration — plugins.yaml"). Read:
// router, answerer, assessor, executors, attachedMachines. The other sections are allowed so the file can be written
// whole, but nothing reads them yet.
import { readFileSync, statSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import type { AttachedMachine, InstanceSpec } from '../domain/types.ts';

export type PluginsFileResult =
  | { missing: true }
  /** `answerer: null` = no answerer configured; absent = derive it. */
  | {
    router?: InstanceSpec; answerer?: InstanceSpec | null; assessor?: InstanceSpec; executors?: InstanceSpec[];
    attachedMachines?: AttachedMachine[]; warnings: string[];
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

const attachedMachine = z.strictObject({
  name: z.string().min(1).refine((n) => n !== 'local', 'local is this machine; name an attached machine something else'),
  label: z.string().min(1).optional(),
  ssh: z.string().min(1).refine((s) => !s.startsWith('-'), 'ssh must be a destination, not an option'),
  lanes: z.number().int().min(1, 'lanes must be at least 1'),
  executors: z.array(z.string().min(1)).default(['herdr-claude']),
  session: z.string().min(1).refine((s) => s !== 'default', 'must not be the default herdr session').default('job-hopper'),
  herdrBin: z.string().min(1).default('herdr'),
});

const FILE = z.strictObject({
  version: z.literal(1),
  router: instance.optional(),
  answerer: stageInstance.nullable().optional(),
  assessor: stageInstance.optional(),
  // 1..n; jobs name an executor instance, so a name is one instance.
  executors: z.array(instance).min(1, 'name at least one executor').superRefine((list, ctx) => {
    const seen = new Set<string>();
    for (const e of list) {
      if (seen.has(e.name)) ctx.addIssue({ code: 'custom', message: `executor ${e.name} named twice; jobs name their executor` });
      seen.add(e.name);
    }
  }).optional(),
  // Other hosts that run jobs over ssh; ids unique.
  attachedMachines: z.array(attachedMachine).superRefine((list, ctx) => {
    const seen = new Set<string>();
    for (const m of list) {
      if (seen.has(m.name)) ctx.addIssue({ code: 'custom', message: `machine ${m.name} named twice` });
      seen.add(m.name);
    }
  }).optional(),
  // Read by later slices (sources, notifiers).
  jobSources: z.unknown().optional(),
  machines: z.unknown().optional(),
  usageSources: z.unknown().optional(),
  notifiers: z.unknown().optional(),
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
  const { router, answerer, assessor, executors, attachedMachines } = parsed.data;
  return {
    ...(router ? { router } : {}),
    ...(answerer !== undefined ? { answerer } : {}),
    ...(assessor ? { assessor } : {}),
    ...(executors ? { executors } : {}),
    ...(attachedMachines ? { attachedMachines } : {}),
    warnings,
  };
}
