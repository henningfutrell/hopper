// A user's GitLab account (issue #1448 part 2, design.md "A GitLab source"): the GitLab account a user attaches with a
// personal access token, at gitlab.com or at a GitLab of their own, with the projects picked for it. Its token is a system
// secret in the user's vault, never in this record. Re-exported from types.ts.

/** Where a GitLab account is when the person names none. */
export const GITLAB_COM = 'https://gitlab.com';

/** The label a GitLab issue carries to be listed in Intake, as on GitHub. */
export const GITLAB_LABEL = 'hopper';

/**
 * The GitLab account as kept (a user setting): who the token is, where, and the projects picked. `ended`: GitLab refused the
 * token (issue #1380, "a source expiring marks only the source"): only this account is marked; a new token connects it again.
 */
export interface GitLabAccountRecord {
  /** The GitLab's URL, with no path and no trailing slash: `https://gitlab.com`, or a GitLab of the user's own. */
  baseUrl: string;
  /** The token's user: its username and its id. */
  account: string;
  userId: number;
  connectedAt: string;
  /** The email the account was connected for (the source email match); absent: not checked. */
  matchEmail?: string;
  /** The projects picked (`group/name`, or `group/subgroup/name`): their issues are listed in Intake. Empty: none. */
  projects: string[];
  /** The projects the token reaches, as last read, and when; absent: not read yet. */
  reached?: string[];
  reachedAt?: string;
  /** Why the last read of the projects failed; `reached` then holds the read before it, if any. */
  reachError?: string;
  ended?: { at: string; error: string };
}

/**
 * The GitLab account as GET /api/gitlab-account answers it: facts only, never the token. `not-connected` with `error`: why the
 * last connect failed. `failed`: a connect's answer when it was refused; an account there was stays as it was.
 */
export type GitLabAccountStatus =
  | { state: 'not-connected'; error?: string }
  | { state: 'failed'; error: string }
  | ({ state: 'connected' } & Omit<GitLabAccountRecord, 'ended'>)
  | ({ state: 'expired'; error: string } & Omit<GitLabAccountRecord, 'ended'>)
  /** Its token is sealed under a key the runtime does not give: not ended, give the key back. */
  | ({ state: 'unreadable'; error: string } & Omit<GitLabAccountRecord, 'ended'>);

/** One GitLab issue as the GitLab source reads it. */
export interface GitLabIssue {
  project: string;
  iid: number;
  title: string;
  description: string;
  url: string;
  author: string;
  assignees: string[];
  labels: string[];
}

/**
 * A GitLab URL as kept: https, or http on a loopback host (a GitLab on this machine, and the tests); no credentials, no
 * query; the path kept (a GitLab under a path), with no trailing slash. Undefined: not such a URL.
 */
export function gitlabBaseUrl(text: string): string | undefined {
  let u: URL;
  try { u = new URL(text.trim()); } catch { return undefined; }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return undefined;
  if (u.username || u.password || u.search || u.hash) return undefined;
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/** Whether `s` is a GitLab project path: `group/name`, with any number of subgroups. */
export const isGitLabProject = (s: string): boolean => /^[\w.-]+(\/[\w.-]+)+$/.test(s);
