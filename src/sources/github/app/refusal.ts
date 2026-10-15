// "Resource not accessible by integration" (issue #1351): GitHub refuses a GitHub App's token — the hopper's app for a
// connected account, an admin's app for the app source — when the app lacks a permission, or is not installed on the
// repository's owner with that repository. GitHub's words name neither, so the hopper adds the permission GitHub asks
// for (REST: the x-accepted-github-permissions header; GraphQL: the field it refused) and the fix.

/** GitHub's names of the permissions, as its app settings page shows them. */
const NAMES: Record<string, string> = {
  actions: 'Actions', administration: 'Administration', checks: 'Checks', contents: 'Contents', issues: 'Issues',
  metadata: 'Metadata', organization_projects: 'Projects', pull_requests: 'Pull requests', repository_projects: 'Projects',
  statuses: 'Commit statuses', workflows: 'Workflows',
};

/** The GraphQL fields the hopper reads, by the permission each needs. */
const FIELDS: Record<string, string> = {
  statusCheckRollup: 'checks=read,statuses=read', checkSuites: 'checks=read', pullRequests: 'pull_requests=read',
  pullRequest: 'pull_requests=read', closedByPullRequestsReferences: 'pull_requests=read', projectV2: 'organization_projects=read',
  projectsV2: 'organization_projects=read', issue: 'issues=read', issues: 'issues=read', timelineItems: 'issues=read',
};

export const notAccessible = (message: string): boolean => /resource not accessible by integration/i.test(message);

/** `checks=read,statuses=read; contents=read` in plain words: a set needs all its permissions, any one set will do. */
export function permissionsOfHeader(header: unknown): string | undefined {
  if (typeof header !== 'string') return undefined;
  const sets = header.split(';').map((set) => set.split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
    const [name = '', level = ''] = p.split('=');
    return `${NAMES[name] ?? name} (${level})`;
  }).join(' and ')).filter(Boolean);
  return sets.length ? sets.join(' or ') : undefined;
}

/** The permission a GraphQL field refused needs: the field nearest the end of its path that the hopper knows. */
export function permissionsOfPath(path: readonly (string | number)[] | undefined): string | undefined {
  const field = [...(path ?? [])].reverse().find((p): p is string => typeof p === 'string' && p in FIELDS);
  return field ? permissionsOfHeader(FIELDS[field]) : undefined;
}

/** `message`, and when it is GitHub's refusal of the app, what the app needs and the fix. */
export function explained(message: string, permissions: string | undefined): string {
  if (!notAccessible(message)) return message;
  const needs = permissions ? `the GitHub App needs ${permissions} on this repository` : 'the GitHub App lacks a permission on this repository, or is not installed on it';
  return `${message} (${needs}: install it on the repository's owner with this repository, and accept its new permissions on the installation)`;
}

/** The permissions GitHub asks for in an Octokit request error's answer. */
export const permissionsOfError = (err: unknown): string | undefined =>
  permissionsOfHeader((err as { response?: { headers?: Record<string, unknown> } }).response?.headers?.['x-accepted-github-permissions']);
