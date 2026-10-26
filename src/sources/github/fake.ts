// In-memory GitHub implementing GitHubApi, plus helpers for tests to play the owner (or a
// stranger) on the other side: create issues, reply, open a pull request that closes one on merge or ships part of
// one ("Part of #N", issue #579), merge or close a pull request, close an issue (by hand or by merging a pull request),
// unlabel, assign and unassign, delete, set project items; set a pull request's checks, open one that names no issue but
// in its branch (issue #637); mention an issue from a pull request of any repository or a commit, closing it on GitHub or
// not (issue #430). The hopper's own merge (`merge`, yolo mode) merges as a person's does; a draft or one with
// merge conflicts is refused (405). An issue is assigned to the fake's own login unless
// `assignees` says otherwise (issue #387: intake is by label and assignee).
// Its identity: a connected account (writes appear as `login`, through the hopper's app).
// A repository listing (issue #985) lists the open issues of each repository with one of the labels; a repository
// `failRepo` names is one GitHub does not answer for. A repository's visibility and a pull request by anyone, of a fork or
// not, are what an issue's text can name (issue #655 part 19, fake-links.ts). Each change to an issue moves its `updatedAt`, as on GitHub.

import type { ItemEdit } from '../../domain/item-snapshots.ts';
import { GitHubApiError } from './api.ts';
import { fakeJobLogs } from './fake-job-logs.ts';
import { fakeReviews } from './fake-reviews.ts';
import { fakeHeadChecks } from './fake-head-checks.ts';
import type { BranchPullRequest, ClosingPullRequest, GitHubApi, GitHubComment, GitHubIssue, GitHubProjectItem, IssueEvent, NumberedPullRequest, OpenPullRequest, ReferencingPullRequest } from './api.ts';

import { createFakeCrossReferences } from './fake-cross-references.ts';
import type { FakeActor, FakeGitHub, Method, PullRequestInput } from './fake-types.ts';
import { fakeConflicts } from './fake-conflicts.ts'; import { fakeChangedLines } from './fake-changed-lines.ts';
import { fakeIssuePlace } from './fake-issue-place.ts';
import { fakePulls } from './fake-pulls.ts';
import { fakePullActs } from './fake-pull-acts.ts';
import { fakeListing } from './fake-listing.ts'; import { fakeLinks } from './fake-links.ts';

export type { FakeActor, FakeGitHub, PullRequestInput } from './fake-types.ts';

/** The app the fake's own writes go through (issue #652): a connected account's are marked with the hopper's app. */
export const FAKE_HOPPER_APP = 'hopper-test-app';

const notFound = (what: string) => new GitHubApiError(`gh: Not Found (HTTP 404): ${what}`, true, 404);
const notOpen = (url: string): never => { throw new Error(`no open pull request ${url}`); };

/** `defaultBranch` (issue #1337): a merge into another base closes no issue, as on GitHub. Absent: every merge closes it. */
export function createFakeGitHub(o: { login?: string; defaultBranch?: string } = {}): FakeGitHub {
  const human = o.login ?? 'owner';
  const issues = new Map<string, GitHubIssue>();
  const comments = new Map<string, GitHubComment[]>();
  const assigned = new Map<string, { login: string; at: string }[]>();
  const edits = new Map<string, ItemEdit[]>();
  const events = new Map<string, IssueEvent[]>();
  /** Record a label or an assignment on the issue by `by` (issue #652). */
  const happened = (k: string, e: { event: 'labeled'; label: string } | { event: 'assigned'; assignee: string } | { event: 'reopened' }, by: FakeActor, at: string): void => {
    const who: Exclude<FakeActor, string> = typeof by === 'string' ? { login: by } : by;
    events.set(k, [...(events.get(k) ?? []), { ...e, at, actor: who.login, ...('id' in who && who.id !== undefined ? { actorId: who.id } : {}), actorType: who.type ?? (/\[bot\]$/.test(who.login) ? 'Bot' : 'User'), ...(who.viaApp ? { viaApp: who.viaApp } : {}) }]);
  };
  /** The fake's own writes: as the connected account, through the hopper's app. */
  const self: FakeActor = { login: human, viaApp: FAKE_HOPPER_APP };
  const labels = new Map<string, Set<string>>();
  const conflicts = fakeConflicts((m, a) => enter(m, a), (url) => { const p = pull(url); Object.assign(p, { headCommittedAt: new Date().toISOString(), conflicting: false }); if (p.checks) p.checks = 'pending'; });
  const closers = new Map<string, ClosingPullRequest>();
  const subIssues = new Map<string, string[]>(); const diffs = new Map<string, NonNullable<PullRequestInput['diff']>>();
  /** Every pull request, by the issue it mentions: a closing one, or a part. */
  const pulls: (ReferencingPullRequest & { issue: string; closes: boolean; mergedAt?: string; closedAt?: string; headRef: string; base?: string; crossReferenced?: false })[] = [];
  const addPull = (repo: string, issue: string, o: PullRequestInput, closes: boolean, body: string): OpenPullRequest => {
    const number = ++pullNumber;
    const pr = {
      url: `https://github.com/${repo}/pull/${number}`, createdAt: o.createdAt, isDraft: o.isDraft ?? false, conflicting: o.conflicting ?? false,
      headCommittedAt: o.headCommittedAt ?? o.createdAt, ...(o.checks ? { checks: o.checks } : {}), ...(o.commits ? { commits: o.commits } : {}), ...(o.files ? { files: o.files } : {}),
    };
    pulls.push({ ...pr, state: 'open', body, repo, issue, closes, headRef: o.headRef ?? `branch-${number}`, base: o.base ?? 'dev', ...(o.headOid ? { headOid: o.headOid } : {}), ...(o.crossReferenced === false ? { crossReferenced: false as const } : {}) }); if (o.diff) diffs.set(pr.url, o.diff);
    return { ...pr };
  };
  const openPull = (repo: string, n: number, o: PullRequestInput, closes: boolean, says = closes ? 'Closes' : 'Part of'): OpenPullRequest => {
    find(repo, n);
    return addPull(repo, key(repo, n), o, closes, o.body ?? `${says} #${n}`);
  };
  /** As the port answers a pull request: without the fake's own fields; with its branches, as GitHub says them (issue #2132). */
  const shown = ({ url, createdAt, isDraft, conflicting, headCommittedAt, checks, headRef, base }: OpenPullRequest): OpenPullRequest =>
    ({ url, createdAt, isDraft, conflicting, ...(headCommittedAt ? { headCommittedAt } : {}), ...(checks ? { checks } : {}), ...(headRef ? { headRef } : {}), ...(base ? { base } : {}) });
  const merged = (p: (typeof pulls)[number], at: string, by = human) => {
    Object.assign(p, { state: 'merged', mergedAt: at });
    for (const q of pulls) if (q.state === 'open' && conflicts.conflictsWith(p.url).includes(q.url)) q.conflicting = true;
    if (!p.closes || (o.defaultBranch !== undefined && p.base !== o.defaultBranch)) return;
    Object.assign(issues.get(p.issue)!, { state: 'closed', closedBy: by, closedAt: at, stateReason: 'completed' }); touch(issues.get(p.issue)!);
    closers.set(p.issue, { url: p.url, createdAt: p.createdAt, mergedAt: at });
  };
  const pull = (url: string) => pulls.find((x) => x.url === url && x.state === 'open') ?? notOpen(url);
  let pullNumber = 1000;
  const xrefs = createFakeCrossReferences(issues, human, addPull);
  const projects = new Map<string, GitHubProjectItem[] | Error>();
  const failures = new Map<Method, Error[]>();
  const calls: { method: Method; args: unknown[] }[] = [];
  const jobLogs = fakeJobLogs((m, a) => enter(m, a));
  const reviews = fakeReviews((m, a) => enter(m, a));
  let commentId = 1000;
  let tick = 0;
  const stamp = () => new Date(Date.UTC(2026, 9, 2, 9, 0, tick++)).toISOString();
  const key = (repo: string, n: number) => `${repo}#${n}`;
  const repoLabels = (repo: string) => labels.get(repo) ?? labels.set(repo, new Set()).get(repo)!;

  const find = (repo: string, n: number): GitHubIssue => {
    const i = issues.get(key(repo, n));
    if (!i) throw notFound(`${repo}#${n}`);
    return i;
  };
  /** Its sub-issues as GitHub counts them (issue #729): only those that still exist. */
  const subsOf = (i: GitHubIssue, c = (subIssues.get(key(i.repo, i.number)) ?? []).flatMap((k) => issues.get(k) ?? [])) =>
    c.length ? { subIssues: { total: c.length, closed: c.filter((x) => x.state === 'closed').length } } : {};
  const copy = (i: GitHubIssue): GitHubIssue => ({ ...i, assignees: [...i.assignees], labels: [...i.labels], ...subsOf(i) });
  const enter = (method: Method, args: unknown[]) => {
    calls.push({ method, args });
    const err = failures.get(method)?.shift();
    if (err) throw err;
  };
  const open = (label: string) => [...issues.values()].filter((i) => i.state === 'open' && i.labels.includes(label));
  /** A change to the issue: its `updatedAt` moves. */
  const touch = (i: GitHubIssue) => { i.updatedAt = stamp(); };
  const listing = fakeListing(issues, (m, a) => enter(m, a)); const links = fakeLinks((m, a) => enter(m, a));
  const acts = fakePullActs(pulls, (m, a) => enter(m, a), notFound);
  const batched = fakePulls(pulls, issues, (m, a) => enter(m, a));
  const pullOf = (repo: string, n: number) => (issues.has(key(repo, n)) ? undefined : pulls.find((p) => p.url === `https://github.com/${repo}/pull/${n}`));
  const heads = fakeHeadChecks((m, a) => enter(m, a), (repo, ref) => pulls.find((p) => p.repo === repo && (p.headRef === ref || p.headOid === ref))?.url);

  const api: GitHubApi = {
    listRepos: listing.listRepos, issuesChangedSince: listing.issuesChangedSince, pullRequestStates: batched.pullRequestStates, openPullRequestsIn: batched.openPullRequestsIn, mergedPullRequestsInto: batched.mergedPullRequestsInto,
    async getIssue(repo, n) { enter('getIssue', [repo, n]); return copy(find(repo, n)); },
    async subIssues(repo, n) {
      enter('subIssues', [repo, n]);
      return (subIssues.get(key(repo, n)) ?? []).flatMap((k) => issues.get(k) ?? []).map((i) => ({ repo: i.repo, number: i.number, state: i.state }));
    },
    async listComments(repo, n) {
      enter('listComments', [repo, n]);
      if (!pullOf(repo, n)) find(repo, n);
      return (comments.get(key(repo, n)) ?? []).map((c) => ({ ...c }));
    },
    async issueEdits(repo, n) {
      enter('issueEdits', [repo, n]);
      find(repo, n);
      return (edits.get(key(repo, n)) ?? []).map((e) => ({ ...e }));
    },
    async projectItems(owner, n) {
      enter('projectItems', [owner, n]);
      const p = projects.get(`${owner}/${n}`);
      if (p instanceof Error) throw p;
      if (!p) throw new GitHubApiError(`project ${owner}/${n} not found`, true, 404);
      return p.map((i) => ({ ...i, fields: { ...i.fields } }));
    },
    async issuePlace(repo, n) { enter('issuePlace', [repo, n]); return fakeIssuePlace({ issues, subIssues, pulls, projects }, find(repo, n)); },
    async ensureLabel(repo, name, color, description) { enter('ensureLabel', [repo, name, color, description]); repoLabels(repo).add(name); },
    async addLabels(repo, n, names) {
      enter('addLabels', [repo, n, names]);
      const i = find(repo, n);
      const missing = names.find((l) => !repoLabels(repo).has(l));
      if (missing) throw new GitHubApiError(`gh: label '${missing}' not found (HTTP 422)`, true, 422);
      for (const l of names) {
        if (i.labels.includes(l)) continue;
        i.labels.push(l);
        happened(key(repo, n), { event: 'labeled', label: l }, self, stamp()); touch(i);
      }
    },
    async removeLabels(repo, n, names) {
      enter('removeLabels', [repo, n, names]);
      const i = find(repo, n);
      if (i.labels.some((l) => names.includes(l))) touch(i);
      i.labels = i.labels.filter((l) => !names.includes(l));
    },
    async assignedAt(repo, n, login) {
      enter('assignedAt', [repo, n, login]);
      find(repo, n);
      return (assigned.get(key(repo, n)) ?? []).filter((e) => e.login.toLowerCase() === login.toLowerCase()).map((e) => e.at).sort().at(-1);
    },
    async issueEvents(repo, n) {
      enter('issueEvents', [repo, n]);
      find(repo, n);
      return (events.get(key(repo, n)) ?? []).map((e) => ({ ...e }));
    },
    async addAssignees(repo, n, logins) {
      enter('addAssignees', [repo, n, logins]);
      const i = find(repo, n);
      for (const login of logins) {
        if (!i.assignees.includes(login)) i.assignees.push(login);
        const at = stamp();
        assigned.set(key(repo, n), [...(assigned.get(key(repo, n)) ?? []), { login, at }]);
        happened(key(repo, n), { event: 'assigned', assignee: login }, self, at); touch(i);
      }
    },
    async postComment(repo, n, body) {
      enter('postComment', [repo, n, body]);
      const onPull = issues.has(key(repo, n)) ? undefined : acts.comment(repo, n, body, commentId + 1);
      if (onPull) { commentId += 1; return onPull; }
      const i = find(repo, n);
      const at = stamp();
      const c: GitHubComment = { id: ++commentId, author: human, body, createdAt: at, updatedAt: at, url: `${i.url}#issuecomment-${commentId}` };
      comments.set(key(repo, n), [...(comments.get(key(repo, n)) ?? []), c]); touch(i);
      return { id: c.id, url: c.url };
    },
    async closeAsCompleted(repo, n) {
      enter('closeAsCompleted', [repo, n]);
      const i = find(repo, n); Object.assign(i, { state: 'closed', closedBy: human, closedAt: stamp(), stateReason: 'completed' }); touch(i);
    },
    async closeAsNotPlanned(repo, n) {
      enter('closeAsNotPlanned', [repo, n]);
      const i = find(repo, n); Object.assign(i, { state: 'closed', closedBy: human, closedAt: stamp(), stateReason: 'not_planned' }); touch(i);
    },
    async reopenIssue(repo, n) {
      enter('reopenIssue', [repo, n]);
      const i = find(repo, n);
      i.state = 'open';
      delete i.closedBy; delete i.closedAt; delete i.stateReason; touch(i);
      happened(key(repo, n), { event: 'reopened' }, self, i.updatedAt);
    },
    closingPullRequest: async (repo, n) => { enter('closingPullRequest', [repo, n]); find(repo, n); const pr = closers.get(key(repo, n)); return pr ? { ...pr } : undefined; },
    async openClosingPullRequests(repo, n) {
      enter('openClosingPullRequests', [repo, n]);
      return find(repo, n).state === 'open' ? pulls.filter((p) => p.issue === key(repo, n) && p.closes && p.state === 'open').map(shown) : [];
    },
    async referencingPullRequests(repo, n) {
      enter('referencingPullRequests', [repo, n]);
      find(repo, n);
      return pulls.filter((p) => p.issue === key(repo, n) && p.crossReferenced !== false).map(({ issue: _i, closes: _c, crossReferenced: _x, ...p }) => ({ ...p }));
    },
    crossReferences: async (repo, n) => { enter('crossReferences', [repo, n]); find(repo, n); return xrefs.of(key(repo, n), pulls); },
    async pullRequest(repo, n) {
      enter('pullRequest', [repo, n]);
      const p = pulls.find((x) => x.url === `https://github.com/${repo}/pull/${n}`);
      if (!p) return undefined;
      const { issue: _i, closes: _c, body: _b, repo: _r, crossReferenced: _x, ...pr } = p;
      return { ...pr } satisfies NumberedPullRequest;
    },
    async openPullRequests(repo) {
      enter('openPullRequests', [repo]);
      return pulls.filter((p) => p.repo === repo && p.state === 'open').reverse().map((p): BranchPullRequest => ({ ...shown(p), headRef: p.headRef, body: p.body }));
    },
    async merge(repo, n) {
      enter('merge', [repo, n]);
      const p = pulls.find((x) => x.url === `https://github.com/${repo}/pull/${n}`);
      if (!p) throw notFound(`${repo}/pull/${n}`);
      if (p.state !== 'open' || p.isDraft || p.conflicting) throw new GitHubApiError(`Pull Request is not mergeable (HTTP 405): ${p.url}`, true, 405);
      merged(p, new Date().toISOString(), human);
    },
    ...acts.api,
    jobLog: jobLogs.jobLog,
    rerunJob: jobLogs.rerunJob, workflowRun: jobLogs.workflowRun, pullRequestReviews: reviews.pullRequestReviews,
    headChecks: heads.headChecks, checkRuns: heads.checkRuns, ...links.api,
  };

  // A connected account's listing across repos.
  api.listAssignedIssues = async (label) => {
    enter('listAssignedIssues', [label]);
    return open(label).filter((i) => i.assignees.some((a) => a.toLowerCase() === human.toLowerCase())).map(copy);
  };

  const fake: FakeGitHub = {
    ...api,
    calls,
    createIssue({ repo, title, body, author, authorId, assignees, labels: ls, labelledBy, assignedBy, parent }) {
      const number = [...issues.values()].filter((i) => i.repo === repo).length + 1;
      for (const l of ls ?? []) repoLabels(repo).add(l);
      const issue: GitHubIssue = {
        repo, number, url: `https://github.com/${repo}/issues/${number}`, title: title ?? `Issue ${number}`,
        body: body ?? `Do thing ${number}.`, author: author ?? human, ...(authorId !== undefined ? { authorId } : {}), assignees: [...(assignees ?? [human])], labels: [...(ls ?? [])], state: 'open', updatedAt: stamp(),
      };
      issues.set(key(repo, number), issue);
      if (parent !== undefined) subIssues.set(key(repo, parent), [...(subIssues.get(key(repo, parent)) ?? []), key(repo, number)]);
      assigned.set(key(repo, number), issue.assignees.map((login) => ({ login, at: issue.updatedAt })));
      const byAuthor: FakeActor = { login: issue.author, ...(authorId !== undefined ? { id: authorId } : {}) }; for (const label of issue.labels) happened(key(repo, number), { event: 'labeled', label }, labelledBy ?? byAuthor, issue.updatedAt);
      for (const login of issue.assignees) happened(key(repo, number), { event: 'assigned', assignee: login }, assignedBy ?? byAuthor, issue.updatedAt);
      return copy(issue);
    },
    async fileIssue(repo, { title, body, labels: ls, assignees }) { enter('fileIssue', [repo, title]); const i = fake.createIssue({ repo, title, body, labels: ls, assignees, labelledBy: self, assignedBy: self }); return { number: i.number, url: i.url }; },
    addComment(repo, n, author, body, association, viaApp) {
      // On a pull request too (issue #1924: a plan comment), which has no issue of its own here.
      const pull = pullOf(repo, n); const i = pull ? { url: pull.url, updatedAt: '' } as GitHubIssue : find(repo, n);
      const at = stamp();
      const c: GitHubComment = { id: ++commentId, author, body, createdAt: at, updatedAt: at, url: `${i.url}#issuecomment-${commentId}`, ...(association ? { association } : {}), ...(viaApp ? { viaApp } : {}) };
      comments.set(key(repo, n), [...(comments.get(key(repo, n)) ?? []), c]); touch(i);
      return { ...c };
    },
    reopenedBy(repo, n, by) { happened(key(repo, n), { event: 'reopened' }, by, stamp()); },
    editIssue(repo, n, change, editor, at = new Date().toISOString()) {
      const i = find(repo, n);
      const made: ItemEdit[] = [];
      if (change.title !== undefined) { i.title = change.title; i.updatedAt = at; made.push({ what: 'title', editor, at }); }
      if (change.body !== undefined) { i.body = change.body; i.updatedAt = at; made.push({ what: 'body', editor, at }); }
      edits.set(key(repo, n), [...(edits.get(key(repo, n)) ?? []), ...made]);
    },
    closeIssue(repo, n, closedBy, c = {}) {
      const i = find(repo, n); Object.assign(i, { state: 'closed', closedBy: closedBy ?? human, closedAt: c.at ?? stamp(), stateReason: c.reason ?? 'completed' }); touch(i);
      closers.delete(key(repo, n));
    },
    openPullRequest: (repo, n, o) => openPull(repo, n, o, true),
    openPartPullRequest: (repo, n, o) => openPull(repo, n, o, false),
    openReferencingPullRequest: (repo, n, o) => openPull(repo, n, o, false, 'Refs'),
    openUnlinkedPullRequest: (repo, o) => addPull(repo, '', o, false, o.body ?? 'A change.'),
    mentionIssue: (repo, n, m) => { find(repo, n); return xrefs.mention(key(repo, n), repo, m); },
    setChecks(url, checks, failedChecks) { const p = pull(url); if (checks) p.checks = checks; else delete p.checks; if (failedChecks) p.failedChecks = failedChecks; else delete p.failedChecks; },
    mergePullRequest(url, at) { merged(pull(url), at ?? new Date().toISOString()); },
    closePullRequest(url, at) { Object.assign(pull(url), { state: 'closed', closedAt: at ?? new Date().toISOString() }); },
    markReady(url) { pull(url).isDraft = false; },
    setHeadChecks: heads.setHeadChecks, setCheckRuns: heads.setCheckRuns, setJobLog: jobLogs.setJobLog, setWorkflowRun: jobLogs.setWorkflowRun, setReviews: reviews.setReviews, jobReruns: jobLogs.reruns, setRerunError: jobLogs.setRerunError,
    setConflicting(url, conflicting) { pull(url).conflicting = conflicting; }, ...conflicts.methods, ...fakeChangedLines((m, a) => enter(m, a), (url) => diffs.get(url)),
    pushToPullRequest(url, at, o = {}) { Object.assign(pull(url), { headCommittedAt: at, conflicting: o.conflicting ?? false }); },
    closeByPullRequest(repo, n, { createdAt, mergedAt }) {
      const i = find(repo, n); Object.assign(i, { state: 'closed', closedBy: human, closedAt: mergedAt, stateReason: 'completed' }); touch(i);
      const pr = { url: `https://github.com/${repo}/pull/${++pullNumber}`, createdAt, mergedAt };
      pulls.push({ url: pr.url, createdAt, isDraft: false, conflicting: false, headCommittedAt: createdAt, mergedAt, state: 'merged', body: `Closes #${n}`, repo, issue: key(repo, n), closes: true, headRef: `branch-${pullNumber}`, base: 'dev' });
      closers.set(key(repo, n), pr);
      return { ...pr };
    },
    assign(repo, n, login, at, by) {
      const i = find(repo, n);
      if (!i.assignees.includes(login)) i.assignees.push(login);
      const when = at ?? new Date().toISOString();
      assigned.set(key(repo, n), [...(assigned.get(key(repo, n)) ?? []), { login, at: when }]);
      happened(key(repo, n), { event: 'assigned', assignee: login }, by ?? human, when); touch(i);
    },
    unassign(repo, n, login) { const i = find(repo, n); i.assignees = i.assignees.filter((l) => l !== login); touch(i); },
    deleteIssue(repo, n) { find(repo, n); issues.delete(key(repo, n)); },
    addLabel(repo, n, label, by) {
      repoLabels(repo).add(label);
      const i = find(repo, n);
      if (i.labels.includes(label)) return;
      i.labels.push(label);
      happened(key(repo, n), { event: 'labeled', label }, by ?? human, new Date().toISOString()); touch(i);
    },
    removeLabel(repo, n, label) { const i = find(repo, n); i.labels = i.labels.filter((l) => l !== label); touch(i); },
    setProjectItems(owner, n, items) {
      projects.set(`${owner}/${n}`, items instanceof Error ? items : items.map((it, index) => ({ url: it.url, index, fields: { ...(it.fields ?? {}) } })));
    },
    failRepo: listing.failRepo,
    failNext(method, error) { failures.set(method, [...(failures.get(method) ?? []), error]); },
    issue(repo, n) { return copy(find(repo, n)); },
    commentsOn(repo, n) { return (comments.get(key(repo, n)) ?? []).map((c) => ({ ...c })); },
    ...acts.helpers, ...links.helpers,
    labelsIn(repo) { return [...repoLabels(repo)]; },
  };
  return fake;
}
