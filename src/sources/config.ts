// The GitHub job source's options (the plugins config `jobSources[].options` of `github-account`), and the
// source config they turn into: `model: null` dropped. No path: a job's work tree is its machine's (issue #361). The plugin host validates
// them with these schemas; an invalid instance is dropped with the error shown. There is no `authors`
// option (issue #387): a source takes an issue by its label and its assignee, never by who filed it. An
// instance still carrying one loads with it dropped; tenant migration 16 removes it from the stored config. There
// is no `completion` option either (issue #579): done is always a pull request ready for review, and whether a job
// may merge it is yolo mode, a setting of the user's (src/domain/yolo-mode.ts). Dropped on load the same way;
// tenant migration 30 removes it.
import { z } from 'zod';
import { isConnectedAccountKey } from '../domain/connected-accounts.ts';

const projectSchema = z.object({
  owner: z.string().min(1),
  number: z.number().int().positive(),
  mode: z.enum(['field', 'rank']),
  field: z.string().min(1).optional(),
  map: z.record(z.string(), z.number()).optional(),
}).strict().refine((p) => p.mode !== 'field' || p.field !== undefined, { message: 'mode field needs a field name', path: ['field'] });

/** The GitHub source's keys. A working directory is command-bearing. */
const sharedKeys = {
  pollSeconds: z.number().int().positive().default(60),
  repos: z.array(z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'owner/repo')).default([]),
  label: z.string().min(1).default('hopper'),
  hopperName: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, 'lowercase letters, digits, . _ -').nullable().default(null)
    .meta({ description: 'this hopper\'s name: an issue labelled hopper@<name> is taken only by the hopper of that name; null takes only issues addressed to no hopper' }),
  priorityLabels: z.record(z.string(), z.number()).default({ 'hopper:high': 75, 'hopper:low': 25 }),
  defaultPriority: z.number().min(0).max(100).default(50),
  executor: z.string().min(1).default('herdr-claude'),
  model: z.string().min(1).nullable().default(null),
  recentComments: z.number().int().min(0).default(10),
  projects: z.record(z.string(), projectSchema).default({}),
  issueGraph: z.boolean().default(true).meta({ description: 'keep the issue graph: each listed issue with its repository, owner, Projects and linked issues and pull requests' }),
  graphRefreshMinutes: z.number().int().min(0).default(60)
    .meta({ description: 'the issue graph: how many minutes an issue\'s place is kept before it is read again, unchanged; 0 reads it at every sync' }),
};

/**
 * Options as stored before issue #387 may carry `authors`, before issue #579 `completion`, before issue #1243
 * `privateKeyEnv` (the key is in the vault now): dropped, not refused.
 */
function withoutGone(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || !('authors' in raw || 'completion' in raw || 'privateKeyEnv' in raw)) return raw;
  const { authors: _authors, completion: _completion, privateKeyEnv: _privateKeyEnv, ...rest } = raw as Record<string, unknown>;
  return rest;
}

/**
 * A connected account's source (issue #214): who it acts as is the account the user connected, so
 * nothing names an identity or a credential, and it takes the issues assigned to that account. Which
 * repositories it lists is no option: they are the user's **job repositories**, chosen in Sources and
 * read at each sync (issue #321). `account`: which of the user's connected accounts (issue #1448): the first (`github`) unless
 * set; the hopper adds one source of its own for each further account, never written to the plugins config.
 */
const { repos: _repos, ...accountShared } = sharedKeys;
const accountKeys = {
  enabled: z.boolean().default(true),
  account: z.string().refine(isConnectedAccountKey, 'a connected account key: github, github-2, …').default('github')
    .meta({ description: 'which of your connected GitHub accounts: github, the first; github-2, … a further one (Sources)' }),
  ...accountShared,
};

/** github-account: the GitHub account the user connected. */
export const githubAccountOptions = z.preprocess(withoutGone, z.object(accountKeys).strict());

/** Both on, and the same issues by label and hopper name (issue #1264). */
const sameIssues = (a: GitHubAccountOptions, b: GitHubAccountOptions): boolean =>
  a.enabled && b.enabled && a.label === b.label && a.hopperName === b.hopperName;

/**
 * Two connected-account sources take the same work (issue #1264) when they take the same issues: both read the same
 * connected account (issue #1448), over its job repositories.
 */
export const sameAccountWork = (a: GitHubAccountOptions, b: GitHubAccountOptions): boolean => a.account === b.account && sameIssues(a, b);

export type GitHubProjectConfig = z.infer<typeof projectSchema>;
export type GitHubAccountOptions = z.output<typeof githubAccountOptions>;

/** What the source logic reads: the shared keys, no `model: null`. */
export type GitHubSourceConfig = Omit<z.output<z.ZodObject<typeof sharedKeys>>, 'model'> & { model?: string };

export function sourceConfig<T extends { model: string | null }>(raw: T): Omit<T, 'model'> & { model?: string } {
  const { model, ...rest } = raw;
  return { ...rest, ...(model ? { model } : {}) };
}
