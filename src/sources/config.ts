// sources.yaml: which sources the hopper pulls from, validated with zod. An invalid file
// yields { error } (the source shows it; the daemon keeps running).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const projectSchema = z.object({
  owner: z.string().min(1),
  number: z.number().int().positive(),
  mode: z.enum(['field', 'rank']),
  field: z.string().min(1).optional(),
  map: z.record(z.string(), z.number()).optional(),
}).strict().refine((p) => p.mode !== 'field' || p.field !== undefined, { message: 'mode field needs a field name', path: ['field'] });

const githubSchema = z.object({
  enabled: z.boolean().default(true),
  pollSeconds: z.number().int().positive().default(60),
  owners: z.array(z.string().min(1)).default([]),
  repos: z.array(z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'owner/repo')).default([]),
  authors: z.array(z.string().min(1)).default(['owner']),
  label: z.string().min(1).default('hopper'),
  priorityLabels: z.record(z.string(), z.number()).default({ 'hopper:p0': 100, 'hopper:p1': 75, 'hopper:p2': 50, 'hopper:p3': 25 }),
  defaultPriority: z.number().min(0).max(100).default(50),
  repoPaths: z.record(z.string(), z.string()).default({}),
  defaultCwd: z.string().min(1).default('~/workbench/workflow-personal-app-management'),
  executor: z.string().min(1).default('herdr-claude'),
  model: z.string().min(1).nullable().default(null),
  progressCommentSeconds: z.number().int().positive().default(300),
  recentComments: z.number().int().min(0).default(10),
  projects: z.record(z.string(), projectSchema).default({}),
}).strict();

const fileSchema = z.object({
  version: z.literal(1),
  github: githubSchema.optional(),
}).strict();

export type GitHubProjectConfig = z.infer<typeof projectSchema>;

export type GitHubSourceConfig = Omit<z.infer<typeof githubSchema>, 'model'> & { model?: string };

export type SourcesFile = { github?: GitHubSourceConfig; note?: string } | { error: string };

function expandHome(p: string): string {
  if (p === '~') return homedir();
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

function finish(raw: z.infer<typeof githubSchema>): GitHubSourceConfig {
  const { model, ...rest } = raw;
  return {
    ...rest,
    defaultCwd: expandHome(rest.defaultCwd),
    repoPaths: Object.fromEntries(Object.entries(rest.repoPaths).map(([k, v]) => [k, expandHome(v)])),
    ...(model ? { model } : {}),
  };
}

/** Validate an already-parsed sources document. */
export function parseSourcesConfig(doc: unknown): { github?: GitHubSourceConfig } | { error: string } {
  const r = fileSchema.safeParse(doc);
  if (!r.success) return { error: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') };
  return { github: r.data.github ? finish(r.data.github) : undefined };
}

export function loadSourcesFile(path: string): SourcesFile {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { github: undefined, note: `no sources file at ${path}` };
    return { error: `${path}: ${(err as Error).message}` };
  }
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    return { error: `${path}: ${(err as Error).message}` };
  }
  const r = parseSourcesConfig(doc);
  return 'error' in r ? { error: `${path}: ${r.error}` } : r;
}
