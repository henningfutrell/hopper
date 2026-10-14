// The GitHubApi port over a connected account's token (issue #214): the user's own GitHub, reached
// through the hopper's GitHub App: what it does acts as that user, with the app marked on it. The same REST and GraphQL calls as the App adapter, each with the
// account's token instead of an installation token.
// `token()` is asked at every call: a disconnect or a new connection applies at once. A token GitHub refuses
// (401) is renewed (`renew`, issue #358) and the call made once more with the new one.
import { GitHubApiError, isPermanent, webOriginOf } from '../api.ts';
import type { GitHubApi } from '../api.ts';
import { closingPullRequest, crossReferences, issueEdits, issuePlace, openClosingPullRequests, openPullRequests, projectItems, pullRequest, referencingPullRequests } from '../app/graphql.ts';
import { batchGraphQL } from '../app/graphql-batch.ts';
import { listRepos } from '../app/graphql-listing.ts';
import { taggedItems } from '../app/graphql-tagged.ts';
import { openPullRequestsIn, pullRequestStates } from '../app/graphql-pulls.ts';
import { SOURCE_DEFER_AFTER_MS, makeRequest, rateLimitedError } from '../app/http.ts';
import * as rest from '../app/rest.ts';

/** What GitHub said, as the port's error: a 401 is the token refused (revoked, or the app's access removed). */
export function accountError(err: unknown, what: string): GitHubApiError {
  if (err instanceof GitHubApiError) return err;
  const limited = rateLimitedError(err, what);
  if (limited) return limited;
  const e = err as { status?: unknown; message?: unknown };
  const status = typeof e.status === 'number' ? e.status : undefined;
  const message = typeof e.message === 'string' ? e.message : String(err);
  if (status === 401) return new GitHubApiError(`${what}: GitHub refused the connected account's token (401: ${message})`, true, 401);
  return new GitHubApiError(`${what}: ${message}`, isPermanent(status, message), status);
}

const refused = (err: unknown) => (err as { status?: unknown }).status === 401;

export function createAccountGitHubApi(o: { apiUrl: string; token(): Promise<string>; renew?(refused: string): Promise<string> }): GitHubApi {
  const req = makeRequest(o.apiUrl, undefined, { deferAfterMs: SOURCE_DEFER_AFTER_MS });
  // The reads that look for new jobs stop at the intake reserve, so a job's own calls still go (issue #983).
  const intake = makeRequest(o.apiUrl, undefined, { deferAfterMs: SOURCE_DEFER_AFTER_MS, intake: true });
  // A change read never waits (issue #1125): the timed listing stays for a sync it could not make.
  const changes = makeRequest(o.apiUrl, undefined, { deferAfterMs: 0, intake: true });
  const ask = batchGraphQL(req);
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
    getIssue: (repo, number) => call(`get ${repo}#${number}`, (t) => rest.getIssue(req, t, repo, number)),
    subIssues: (repo, number) => call(`sub-issues of ${repo}#${number}`, (t) => rest.subIssues(req, t, repo, number)),
    listComments: (repo, number) => call(`comments ${repo}#${number}`, (t) => rest.listComments(req, t, repo, number)),
    issueEdits: (repo, number) => call(`edits of ${repo}#${number}`, (t) => issueEdits(ask, t, repo, number)),
    issuePlace: (repo, number) => call(`place of ${repo}#${number}`, (t) => issuePlace(ask, t, repo, number)),
    projectItems: (owner, number) => call(`project ${owner}/projects/${number}`, (t) => projectItems(intake, t, owner, number)),
    ensureLabel: (repo, name, color, description) => call(`label ${repo} ${name}`, (t) => rest.ensureLabel(req, t, repo, name, color, description)),
    addLabels: (repo, number, labels) => call(`add labels ${repo}#${number}`, (t) => rest.addLabels(req, t, repo, number, labels)),
    removeLabels: (repo, number, labels) => call(`remove labels ${repo}#${number}`, (t) => rest.removeLabels(req, t, repo, number, labels)),
    assignedAt: (repo, number, login) => call(`events of ${repo}#${number}`, (t) => rest.assignedAt(req, t, repo, number, login)),
    issueEvents: (repo, number) => call(`events of ${repo}#${number}`, (t) => rest.issueEvents(req, t, repo, number)),
    addAssignees: (repo, number, logins) => call(`assign ${repo}#${number}`, (t) => rest.addAssignees(req, t, repo, number, logins)),
    listAssignedIssues: (label) => call('issues assigned to the account', (t) => rest.listAssignedIssues(intake, t, label)),
    listRepos: (repos, labels) => call(`list ${repos.length} repositories`, (t) => listRepos(intake, t, repos, labels)),
    taggedItems: (login, repos) => call(`tagged items of ${repos.length} repositories`, (t) => taggedItems(intake, t, login, repos)),
    issuesChangedSince: (repo, since) => call(`changes of ${repo}`, (t) => rest.issuesChangedSince(changes, t, repo, since)),
    reopenIssue: (repo, number) => call(`reopen ${repo}#${number}`, (t) => rest.reopenIssue(req, t, repo, number)),
    closeAsCompleted: (repo, number) => call(`close ${repo}#${number}`, (t) => rest.closeIssue(req, t, repo, number)),
    postComment: (repo, number, body) => call(`comment on ${repo}#${number}`, (t) => rest.postComment(req, t, repo, number, body)),
    closingPullRequest: (repo, number) => call(`closer of ${repo}#${number}`, (t) => closingPullRequest(ask, t, repo, number)),
    openClosingPullRequests: (repo, number) => call(`pull requests of ${repo}#${number}`, (t) => openClosingPullRequests(ask, t, repo, number)),
    referencingPullRequests: (repo, number) => call(`pull requests mentioning ${repo}#${number}`, (t) => referencingPullRequests(ask, t, repo, number)),
    crossReferences: (repo, number) => call(`cross-references of ${repo}#${number}`, (t) => crossReferences(ask, t, repo, number)),
    pullRequest: (repo, number) => call(`pull request ${repo}#${number}`, (t) => pullRequest(ask, t, repo, number)),
    openPullRequests: (repo) => call(`open pull requests of ${repo}`, (t) => openPullRequests(req, t, repo)),
    openPullRequestsIn: (repos) => call(`open pull requests of ${repos.length} repositories`, (t) => openPullRequestsIn(req, t, repos)),
    pullRequestStates: (refs) => call(`${refs.length} pull requests`, (t) => pullRequestStates(req, t, refs)),
    merge: (repo, number) => call(`merge ${repo}#${number}`, (t) => rest.mergePullRequest(req, t, repo, number)),
    closeWithoutMerge: (repo, number) => call(`close ${repo}#${number}`, (t) => rest.closePullRequest(req, t, repo, number)),
    retarget: (repo, number, base) => call(`base of ${repo}#${number}`, (t) => rest.retargetPullRequest(req, t, repo, number, base)),
    toDraft: (repo, number) => call(`draft ${repo}#${number}`, (t) => rest.convertToDraft(req, t, repo, number)),
    jobLog: (repo, jobId) => call(`log of Actions job ${jobId} of ${repo}`, (t) => rest.jobLog(req, t, repo, jobId)),
    gitRemote: (repo) => call(`git of ${repo}`, async (t) => ({ url: `${webOriginOf(o.apiUrl)}/${repo}.git`, token: t })),
  };
}
