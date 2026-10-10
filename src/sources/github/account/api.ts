// The GitHubApi port over a connected account's token (issue #214): the user's own GitHub, reached
// through the hopper's GitHub App: what it does acts as that user, with the app marked on it. The same REST and GraphQL calls as the App adapter, each with the
// account's token instead of an installation token.
// `token()` is asked at every call: a disconnect or a new connection applies at once. A token GitHub refuses
// (401) is renewed (`renew`, issue #358) and the call made once more with the new one.
import { GitHubApiError, isPermanent } from '../api.ts';
import type { GitHubApi } from '../api.ts';
import { closingPullRequest, openClosingPullRequests, projectItems, pullRequest, referencingPullRequests } from '../app/graphql.ts';
import { makeRequest } from '../app/http.ts';
import * as rest from '../app/rest.ts';

/** What GitHub said, as the port's error: a 401 is the token refused (revoked, or the app's access removed). */
export function accountError(err: unknown, what: string): GitHubApiError {
  if (err instanceof GitHubApiError) return err;
  const e = err as { status?: unknown; message?: unknown };
  const status = typeof e.status === 'number' ? e.status : undefined;
  const message = typeof e.message === 'string' ? e.message : String(err);
  if (status === 401) return new GitHubApiError(`${what}: GitHub refused the connected account's token (401: ${message})`, true, 401);
  return new GitHubApiError(`${what}: ${message}`, isPermanent(status, message), status);
}

const refused = (err: unknown) => (err as { status?: unknown }).status === 401;

export function createAccountGitHubApi(o: { apiUrl: string; token(): Promise<string>; renew?(refused: string): Promise<string> }): GitHubApi {
  const req = makeRequest(o.apiUrl);
  const call = async <T>(what: string, fn: (token: string) => Promise<T>): Promise<T> => {
    const token = await o.token();
    try {
      return await fn(token);
    } catch (err) {
      if (!refused(err) || !o.renew) throw accountError(err, what);
    }
    let renewed: string;
    try { renewed = await o.renew(token); } catch (err) { throw new GitHubApiError(`${what}: ${(err as Error).message}`, false); }
    try {
      return await fn(renewed);
    } catch (err) {
      // GitHub refusing the token it just renewed is GitHub refusing the connection (issue #647): the renewer ends it.
      if (refused(err)) await o.renew(renewed).catch(() => undefined);
      throw accountError(err, what);
    }
  };
  return {
    listOpenIssues: (repo, label) => call(`list issues ${repo}`, (t) => rest.listOpenIssues(req, t, repo, label)),
    getIssue: (repo, number) => call(`get ${repo}#${number}`, (t) => rest.getIssue(req, t, repo, number)),
    listComments: (repo, number) => call(`comments ${repo}#${number}`, (t) => rest.listComments(req, t, repo, number)),
    projectItems: (owner, number) => call(`project ${owner}/projects/${number}`, (t) => projectItems(req, t, owner, number)),
    ensureLabel: (repo, name, color, description) => call(`label ${repo} ${name}`, (t) => rest.ensureLabel(req, t, repo, name, color, description)),
    addLabels: (repo, number, labels) => call(`add labels ${repo}#${number}`, (t) => rest.addLabels(req, t, repo, number, labels)),
    removeLabels: (repo, number, labels) => call(`remove labels ${repo}#${number}`, (t) => rest.removeLabels(req, t, repo, number, labels)),
    assignedAt: (repo, number, login) => call(`events of ${repo}#${number}`, (t) => rest.assignedAt(req, t, repo, number, login)),
    addAssignees: (repo, number, logins) => call(`assign ${repo}#${number}`, (t) => rest.addAssignees(req, t, repo, number, logins)),
    listAssignedIssues: (label) => call('issues assigned to the account', (t) => rest.listAssignedIssues(req, t, label)),
    reopenIssue: (repo, number) => call(`reopen ${repo}#${number}`, (t) => rest.reopenIssue(req, t, repo, number)),
    postComment: (repo, number, body) => call(`comment on ${repo}#${number}`, (t) => rest.postComment(req, t, repo, number, body)),
    closingPullRequest: (repo, number) => call(`closer of ${repo}#${number}`, (t) => closingPullRequest(req, t, repo, number)),
    openClosingPullRequests: (repo, number) => call(`pull requests of ${repo}#${number}`, (t) => openClosingPullRequests(req, t, repo, number)),
    referencingPullRequests: (repo, number) => call(`pull requests mentioning ${repo}#${number}`, (t) => referencingPullRequests(req, t, repo, number)),
    pullRequest: (repo, number) => call(`pull request ${repo}#${number}`, (t) => pullRequest(req, t, repo, number)),
  };
}
