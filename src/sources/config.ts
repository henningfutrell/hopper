// sources.yaml: which sources the hopper pulls from, validated with zod. An invalid file
// yields { error } (the source shows it; the daemon keeps running). `github:` is the gh source
// (enabled auto | true | false); `githubApp:` is the App source, present with defaults even when
// the file omits it (it waits for the app file).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const projectSchema = z.object({
  owner: z.string().min(1),
  number: z.number().int().positive(),
  mode: z.enum(['field', 'rank']),
  field: z.string().min(1).optional(),
  map: z.record(z.string(), z.number()).optional(),
}).strict().refine((p) => p.mode !== 'field' || p.field !== undefined, { message: 'mode field needs a field name', path: ['field'] });

/** Keys both GitHub sources share (`github:` and `githubApp:`). */
const sharedKeys = {
  pollSeconds: z.number().int().positive().default(60),
  repos: z.array(z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'owner/repo')).default([]),
  authors: z.array(z.string().min(1)).default(['owner']),
  label: z.string().min(1).default('hopper'),
  priorityLabels: z.record(z.string(), z.number()).default({ 'hopper:p0': 100, 'hopper:p1': 75, 'hopper:p2': 50, 'hopper:p3': 25 }),
  defaultPriority: z.number().min(0).max(100).default(50),
  repoPaths: z.record(z.string(), z.string()).default({}),
  defaultCwd: z.string().min(1).default('~/workbench/app-workflows'),
  executor: z.string().min(1).default('herdr-claude'),
  model: z.string().min(1).nullable().default(null),
  recentComments: z.number().int().min(0).default(10),
  projects: z.record(z.string(), projectSchema).default({}),
};

const githubSchema = z.object({
  // auto: on exactly while no GitHub App is configured (checked every sync).
  enabled: z.union([z.literal('auto'), z.boolean()]).default('auto'),
  owners: z.array(z.string().min(1)).default([]),
  ...sharedKeys,
}).strict();

const githubAppSchema = z.object({
  enabled: z.boolean().default(true),
  /** Default: github-app.json beside sources.yaml. */
  appFile: z.string().min(1).optional(),
  ...sharedKeys,
}).strict();

const fileSchema = z.object({
  version: z.literal(1),
  github: githubSchema.optional(),
  githubApp: githubAppSchema.optional(),
}).strict();

export type GitHubProjectConfig = z.infer<typeof projectSchema>;

export type GitHubSourceConfig = Omit<z.infer<typeof githubSchema>, 'model'> & { model?: string };

export type GitHubAppSourceConfig = Omit<z.infer<typeof githubAppSchema>, 'model' | 'appFile'> & { model?: string; appFile: string };

export type SourcesConfig = { github?: GitHubSourceConfig; githubApp: GitHubAppSourceConfig };

export type SourcesFile = (SourcesConfig & { note?: string }) | { error: string };

const DEFAULT_CONFIG_DIR = '~/.config/job-hopper';

function expandHome(p: string): string {
  if (p === '~') return homedir();
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

function finish<T extends { model: string | null; defaultCwd: string; repoPaths: Record<string, string> }>(raw: T): Omit<T, 'model'> & { model?: string } {
  const { model, ...rest } = raw;
  return {
    ...rest,
    defaultCwd: expandHome(rest.defaultCwd),
    repoPaths: Object.fromEntries(Object.entries(rest.repoPaths).map(([k, v]) => [k, expandHome(v)])),
    ...(model ? { model } : {}),
  };
}

function finishApp(raw: z.infer<typeof githubAppSchema>, configDir: string): GitHubAppSourceConfig {
  const { appFile, ...rest } = finish(raw);
  return { ...rest, appFile: expandHome(appFile ?? join(configDir, 'github-app.json')) };
}

/** Validate an already-parsed sources document. */
export function parseSourcesConfig(doc: unknown, configDir = DEFAULT_CONFIG_DIR): SourcesConfig | { error: string } {
  const r = fileSchema.safeParse(doc);
  if (!r.success) return { error: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') };
  return {
    github: r.data.github ? finish(r.data.github) : undefined,
    githubApp: finishApp(r.data.githubApp ?? githubAppSchema.parse({}), configDir),
  };
}

export function loadSourcesFile(path: string): SourcesFile {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { github: undefined, githubApp: finishApp(githubAppSchema.parse({}), dirname(path)), note: `no sources file at ${path}` };
    }
    return { error: `${path}: ${(err as Error).message}` };
  }
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    return { error: `${path}: ${(err as Error).message}` };
  }
  const r = parseSourcesConfig(doc, dirname(path));
  return 'error' in r ? { error: `${path}: ${r.error}` } : r;
}
