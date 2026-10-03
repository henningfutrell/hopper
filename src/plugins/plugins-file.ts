// plugins.yaml: which instance fills which role (design.md "Configuration — plugins.yaml"). Slice 1
// reads the router section; the other sections are allowed so the file can be written whole, but
// nothing reads them yet.
import { readFileSync, statSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import type { InstanceSpec } from '../domain/types.ts';

export type PluginsFileResult =
  | { missing: true }
  | { router?: InstanceSpec; warnings: string[] }
  | { error: string };

const instance = z.strictObject({
  name: z.string().min(1),
  plugin: z.string().min(1),
  options: z.record(z.string(), z.unknown()).default({}),
});

const FILE = z.strictObject({
  version: z.literal(1),
  router: instance.optional(),
  // Read by later slices (questions, executors, sources, notifiers).
  answerer: z.unknown().optional(),
  assessor: z.unknown().optional(),
  executors: z.unknown().optional(),
  jobSources: z.unknown().optional(),
  machines: z.unknown().optional(),
  usageSources: z.unknown().optional(),
  notifiers: z.unknown().optional(),
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
  return { ...(parsed.data.router ? { router: parsed.data.router } : {}), warnings };
}
