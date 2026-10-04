// The GitHub job sources' options (plugins.yaml `jobSources[].options` of `github-gh` and
// `github-app`; until phase 5 slice 4 the `github:` / `githubApp:` blocks of sources.yaml), and the
// source config they turn into: `~` expanded, `model: null` dropped. The plugin host validates
// them with these schemas; an invalid instance is dropped with the error shown.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const projectSchema = z.object({
  owner: z.string().min(1),
  number: z.number().int().positive(),
  mode: z.enum(['field', 'rank']),
  field: z.string().min(1).optional(),
  map: z.record(z.string(), z.number()).optional(),
}).strict().refine((p) => p.mode !== 'field' || p.field !== undefined, { message: 'mode field needs a field name', path: ['field'] });

const DEFAULT_APP_FILE = '~/.config/job-hopper/github-app.json';

/** Keys both GitHub sources share. A working directory is command-bearing: the UI never edits it. */
const sharedKeys = {
  pollSeconds: z.number().int().positive().default(60),
  repos: z.array(z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'owner/repo')).default([]),
  authors: z.array(z.string().min(1)).min(1).meta({ description: 'GitHub logins whose issues and comments the source accepts; no default' }),
  label: z.string().min(1).default('hopper'),
  priorityLabels: z.record(z.string(), z.number()).default({ 'hopper:high': 75, 'hopper:low': 25 }),
  defaultPriority: z.number().min(0).max(100).default(50),
  repoPaths: z.record(z.string(), z.string()).default({})
    .meta({ commandBearing: true, description: 'owner/repo → the working directory of its jobs' }),
  defaultCwd: z.string().min(1).default('~/workbench/app-workflows')
    .meta({ commandBearing: true, description: 'working directory of jobs from repos not in repoPaths' }),
  executor: z.string().min(1).default('herdr-claude'),
  model: z.string().min(1).nullable().default(null),
  recentComments: z.number().int().min(0).default(10),
  projects: z.record(z.string(), projectSchema).default({}),
};

/** github-gh: the gh source, acting as the owner through the gh CLI. */
export const githubGhOptions = z.object({
  // auto: on exactly while `appFile` is not readable (checked every sync).
  enabled: z.union([z.literal('auto'), z.boolean()]).default('auto'),
  owners: z.array(z.string().min(1)).default([]),
  bin: z.string().min(1).default('gh').meta({ commandBearing: true, description: 'the gh CLI' }),
  appFile: z.string().min(1).nullable().default(DEFAULT_APP_FILE)
    .meta({ commandBearing: true, description: 'with enabled: auto, this source pauses while this GitHub App file is readable; null: never' }),
  ...sharedKeys,
}).strict();

/** github-app: the App source, posting as the app's bot. */
export const githubAppOptions = z.object({
  enabled: z.boolean().default(true),
  // Selects the private key and so the identity the source acts as: command-bearing.
  appFile: z.string().min(1).default(DEFAULT_APP_FILE)
    .meta({ commandBearing: true, description: 'github-app.json, written by create-github-app.sh' }),
  // Where the app's tokens are sent: command-bearing, so a UI session can never redirect them.
  apiUrl: z.url({ protocol: /^https?$/ }).transform((u) => u.replace(/\/+$/, '')).optional()
    .meta({ commandBearing: true, description: 'GitHub API base; unset: https://api.github.com' }),
  ...sharedKeys,
}).strict();

export type GitHubProjectConfig = z.infer<typeof projectSchema>;
export type GitHubGhOptions = z.output<typeof githubGhOptions>;
export type GitHubAppOptions = z.output<typeof githubAppOptions>;

/** What the source logic reads: either plugin's options, `~` expanded, no `model: null`. */
export type GitHubSourceConfig = Omit<GitHubGhOptions, 'model' | 'bin' | 'appFile'> & { model?: string };

export const expandHome = (p: string): string => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

export function sourceConfig<T extends { model: string | null; defaultCwd: string; repoPaths: Record<string, string> }>(raw: T): Omit<T, 'model'> & { model?: string } {
  const { model, ...rest } = raw;
  return {
    ...rest,
    defaultCwd: expandHome(rest.defaultCwd),
    repoPaths: Object.fromEntries(Object.entries(rest.repoPaths).map(([k, v]) => [k, expandHome(v)])),
    ...(model ? { model } : {}),
  };
}
