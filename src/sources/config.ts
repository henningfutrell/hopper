// The GitHub job sources' options (the plugins config `jobSources[].options` of `github-account` and
// `github-app`), and the
// source config they turn into: `model: null` dropped. No path: a job's work tree is its machine's
// (issue #361). The plugin host validates them with these schemas; an invalid instance is dropped with
// the error shown.
import { z } from 'zod';

const projectSchema = z.object({
  owner: z.string().min(1),
  number: z.number().int().positive(),
  mode: z.enum(['field', 'rank']),
  field: z.string().min(1).optional(),
  map: z.record(z.string(), z.number()).optional(),
}).strict().refine((p) => p.mode !== 'field' || p.field !== undefined, { message: 'mode field needs a field name', path: ['field'] });

/** Where the App's private key is, by default (design.md "Secrets"). */
export const DEFAULT_APP_KEY_ENV = 'GITHUB_APP_PRIVATE_KEY';

/** Keys both GitHub sources share. A working directory is command-bearing. */
const sharedKeys = {
  pollSeconds: z.number().int().positive().default(60),
  repos: z.array(z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'owner/repo')).default([]),
  authors: z.array(z.string().min(1)).min(1).meta({ description: 'GitHub logins whose issues and comments the source accepts; no default' }),
  label: z.string().min(1).default('hopper'),
  hopperName: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, 'lowercase letters, digits, . _ -').nullable().default(null)
    .meta({ description: 'this hopper\'s name: an issue labelled hopper@<name> is taken only by the hopper of that name; null takes only issues addressed to no hopper' }),
  priorityLabels: z.record(z.string(), z.number()).default({ 'hopper:high': 75, 'hopper:low': 25 }),
  defaultPriority: z.number().min(0).max(100).default(50),
  executor: z.string().min(1).default('herdr-claude'),
  model: z.string().min(1).nullable().default(null),
  recentComments: z.number().int().min(0).default(10),
  projects: z.record(z.string(), projectSchema).default({}),
  completion: z.enum(['merge', 'pull-request']).default('merge')
    .meta({ description: "when a job's work is done: merge — its pull request merged; pull-request — its pull request open for review. Issue labels hopper:complete-at-merge and hopper:complete-at-pr override it" }),
};

/** github-app: the App source, posting as the app's bot. */
export const githubAppOptions = z.object({
  enabled: z.boolean().default(true),
  // The identity the source acts as, and where its key comes from: command-bearing.
  appId: z.number().int().positive().optional().meta({ commandBearing: true, description: "the GitHub App's id" }),
  slug: z.string().min(1).optional().meta({ commandBearing: true, description: "the GitHub App's slug; its bot is <slug>[bot]" }),
  privateKeyEnv: z.string().min(1).default(DEFAULT_APP_KEY_ENV)
    .meta({ commandBearing: true, description: "environment variable holding the app's private key (PEM; \\n escapes allowed)" }),
  // Where the app's tokens are sent: command-bearing, so a UI session can never redirect them.
  apiUrl: z.url({ protocol: /^https?$/ }).transform((u) => u.replace(/\/+$/, '')).optional()
    .meta({ commandBearing: true, description: 'GitHub API base; unset: https://api.github.com' }),
  ...sharedKeys,
}).strict();

/**
 * A connected account's source (issue #214): who it acts as is the account the user connected, so
 * nothing names an identity or a credential. `authors` empty: the connected account alone. Which
 * repositories it lists is no option: they are the user's **job repositories**, chosen in Sources and
 * read at each sync (issue #321).
 */
const { repos: _repos, ...accountShared } = sharedKeys;
const accountKeys = {
  enabled: z.boolean().default(true),
  ...accountShared,
  authors: z.array(z.string().min(1)).default([])
    .meta({ description: 'logins whose issues and comments the source accepts; empty: the connected account alone' }),
};

/** github-account: the GitHub account the user connected. */
export const githubAccountOptions = z.object(accountKeys).strict();


export type GitHubProjectConfig = z.infer<typeof projectSchema>;
export type GitHubAccountOptions = z.output<typeof githubAccountOptions>;
export type GitHubAppOptions = z.output<typeof githubAppOptions>;

/** What the source logic reads: the shared keys, no `model: null`. */
export type GitHubSourceConfig = Omit<z.output<z.ZodObject<typeof sharedKeys>>, 'model'> & { model?: string };

export function sourceConfig<T extends { model: string | null }>(raw: T): Omit<T, 'model'> & { model?: string } {
  const { model, ...rest } = raw;
  return { ...rest, ...(model ? { model } : {}) };
}
