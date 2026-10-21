// The GitLab source (issue #1448, design.md "A GitLab source", "Jobs through GitLab"): the open issues labelled `hopper` in
// the projects picked for the user's GitLab account, read through that account's token, listed in Intake. An issue assigned
// to the account, of a trusted origin (origin.ts, Access decides), with no end label, becomes a job (part 3): it works in a
// clone of its project, fetched and pushed through the hopper with the account's token (git-broker.ts), and opens its merge
// request with git's push options. The hopper writes only its labels to the issue: `hopper:claimed` while a job holds it,
// then its end label. Paused while no account is attached, its token ended, or no project is picked. A job's merge request
// judges done, and the issue's state gives the job's signals (issue #1642, completion.ts); the hopper follows it after the
// job ends, labels the issue `hopper:pr-ready` while it waits, and merges it in yolo mode once its pipeline passed (part 2,
// follow.ts). An issue of another origin is a request card a person approves (intake.ts), as on GitHub; the job runs the text
// approved.
import type { JobSource, SourceSignal } from '../domain/ports.ts';
import { SourceError } from '../domain/ports.ts';
import type { Job } from '../domain/types.ts';
import type { SourceItem } from '../domain/source-item.ts';
import { NO_INTAKE_TRUST, type IntakeContext, type IntakeOutcome, type IntakeTrust } from '../domain/intake.ts';
import type { IntakeRequest } from '../domain/intake-origin.ts';
import { GITLAB_LABEL, GITLAB_SOURCE_KIND, type GitLabIssue } from '../domain/gitlab-account.ts';
import { LABEL_BACKBURNER, LABEL_CLAIMED, LABEL_DONE, LABEL_FAILED, LABEL_PR_CLOSED, LABEL_PR_READY, LABEL_REJECTED } from '../sources/github/labels.ts';
import { CHECKS_LINE, untrustedBlock } from '../sources/github/context.ts';
import type { GitLabAccount } from './account.ts';
import { GitLabNotFound, type GitLabApi } from './api.ts';
import { gitlabActs, labelledBy, untrustedActs } from './origin.ts';
import { gitlabAutoApproval, gitlabIntakeAct, gitlabVerdict, projectOfKey, takenOn, type GitLabVerdict } from './intake.ts';
import { autoApprovedReason, LABEL_HIGH } from '../domain/intake-auto-approve.ts';
import { openRequests, requestOutcome, withdrawRequests } from '../sources/github/origin.ts';
import { checkJobs, notComplete } from './completion.ts';
import { endChange, followMergeRequest, readyMergeRequest, relabel } from './follow.ts';
import { reportLabels } from '../sources/github/item-labels.ts';
import { mergeRequestHold } from './done-criteria.ts';
import type { JobAllowedDeletes, JobDoneCriteria } from '../sources/github/done-criteria.ts';

/** The labels a job's end leaves on a GitLab issue: any of them keeps the issue out until a person removes it. */
const END_LABELS = [LABEL_DONE, LABEL_FAILED, LABEL_REJECTED, LABEL_PR_READY, LABEL_PR_CLOSED] as const;

export interface GitLabSourceOptions {
  name: string;
  account: GitLabAccount;
  label?: string;
  /** The executor of its jobs, and an optional model (the plugin's options). */
  executor?: string;
  model?: string;
  /** A label's priority; else `defaultPriority`. */
  priorityLabels?: Record<string, number>;
  defaultPriority?: number;
  /**
   * Whether yolo mode is on for a project (issue #1642 part 2), asked by the project's URL at its GitLab (`<GitLab URL>/<project>`),
   * never its path alone, which a GitHub repository may share. Absent: never. And the clock of the no-pipeline grace window.
   */
  yoloMode?: (project: string) => boolean; clock?: { now(): Date };
  /**
   * The user's approvals and declines of request cards (issue #1642), and the intake's events (a card opened, withdrawn).
   * Absent: nothing is approved, and an Approve is refused.
   */
  trust?: IntakeTrust; intake?: IntakeContext;
  /**
   * The done criteria of a job's conditional skills, and the deletes its issue allows (issue #1924 part 4): checked on its merge
   * request at the done check and before yolo mode's merge. Absent: none.
   */
  doneCriteria?: JobDoneCriteria; allowedDeletes?: JobAllowedDeletes;
}

const oneLine = (s: string) => s.replace(/\s*[\r\n]+\s*/g, ' ').trim();
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
/** A double-quoted shell word of `s`, for a push option in the done line. */
const quoted = (s: string): string => `"${s.replace(/["\\$`]/g, (c) => `\\${c}`)}"`;

/** The GitLab line (issue #1448 part 3): where the issue is, what goes through the hopper, and what does not. */
export const gitlabLine = (baseUrl: string): string => `gitlab: this issue and its project are on GitLab at ${baseUrl}, not on GitHub. sh "$HOPPER_GH" acts only on GitHub: do not use it for this job. git fetch and git push to ${baseUrl} go through the hopper by themselves, with the GitLab account the hopper holds: this machine holds no GitLab token. Never log in to GitLab yourself, and do not read GitLab's API or pages: the hopper does not take those for a job yet`;

/** What done means for a GitLab job (issue #1448 part 3): its merge request, opened with git's push options as it pushes. */
export function gitlabDoneLine(iid: number, defaultBranch: string | undefined, title: string): string {
  const target = defaultBranch ?? 'the default branch';
  const push = `git push -o merge_request.create${defaultBranch ? ` -o merge_request.target=${defaultBranch}` : ''} -o merge_request.title=${quoted(oneLine(title))} -o ${quoted(`merge_request.description=Closes #${iid}`)} origin HEAD:<your branch>`;
  return `done: once the change is ready for review — the repo's own checks pass, the change is pushed to a new branch of your own work, and a merge request from it into ${target} is open, not a draft, with no merge conflicts and no failed pipeline, with "Closes #${iid}" in its description. Open the merge request as you push the branch, with git's push options: ${push}. A push goes only to a branch of your own work, never to ${target}. A local commit or an unpushed branch is not done. Do not merge the merge request: a person merges it on GitLab, or the hopper does once its pipeline passed when yolo mode is on`;
}

/** A GitLab call of a report, its error as the SourceError the sync loop reads: an issue GitLab does not find is permanent. */
async function gitlabCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof GitLabNotFound) throw new SourceError(err.message, true, 404);
    throw new SourceError((err as Error).message, false);
  }
}

/**
 * A done job's end on its issue (issue #1642 part 2): closed already, `hopper:done`; else `hopper:pr-ready`, and its ready merge
 * request kept to follow (`follow.ts`), or none named yet, which the follow looks for. The end labels its state does not want
 * come off (issue #1892 part 16).
 */
async function finished(api: GitLabApi, project: string, iid: number, before: Record<string, unknown>): Promise<Record<string, unknown>> {
  const issue = await api.issue(project, iid);
  const closed = issue.state === 'closed';
  const ready = closed ? undefined : await readyMergeRequest(api, project, iid);
  await relabel(api, project, iid, endChange(reportLabels(closed ? { end: 'closed' } : { end: 'pr_open', part: false }, issue.labels), issue.labels));
  return { ...before, reported: 'finished', ...(closed ? {} : { ...(ready ? { pullRequest: ready.url } : {}), follow: 'open' }) };
}

/**
 * The label change of an end the report writes with no read of the issue (issue #1892 part 16): the end label of the state it
 * moves the item to, as `reportLabels` names it, and the claim off. A rejection keeps `hopper:rejected`: the GitLab source reads
 * no rejection record, so the label keeps the issue out.
 */
function unreadEnd(kind: 'failed' | 'cancelled' | 'rejected'): { add: string[]; remove: string[] } {
  const add = kind === 'rejected' ? [LABEL_REJECTED] : reportLabels(kind === 'failed' ? { end: 'failed' } : { end: 'cancelled', tendAgain: false }).add;
  return { add, remove: [LABEL_CLAIMED] };
}

export function createGitLabSource(o: GitLabSourceOptions): JobSource {
  const label = o.label ?? GITLAB_LABEL;
  const priorities = o.priorityLabels ?? { 'hopper:high': 75, 'hopper:low': 25 };
  const fallback = o.defaultPriority ?? 50;
  let outcomes: IntakeOutcome[] = [];
  let repoErrors: Record<string, string> = {};
  let checkErrors: Record<string, string> = {};
  const trust = o.trust ?? NO_INTAKE_TRUST;
  const done = o.doneCriteria ? { criteria: o.doneCriteria, ...(o.allowedDeletes ? { allowedDeletes: o.allowedDeletes } : {}) } : undefined;
  /** The cards approved here that no sync since listed otherwise: key → the hash approved. The texts opened (`openRequests`). */
  const fresh = new Map<string, string>();
  const opened = new Set<string>();
  /** Yolo mode for a project, by its URL at the account's GitLab; no account connected: off. */
  const yolo = (project: string): boolean => {
    const s = o.account.status();
    return s.state === 'connected' && project !== '' && (o.yoloMode?.(`${s.baseUrl}/${project}`) ?? false);
  };

  const priorityOf = (labels: readonly string[]): { priority: number; reason: string } => {
    const hit = Object.entries(priorities).filter(([l]) => labels.includes(l)).sort((a, b) => b[1] - a[1])[0];
    return hit ? { priority: hit[1], reason: `label:${hit[0]}` } : { priority: fallback, reason: 'default' };
  };

  const toItem = (i: GitLabIssue, baseUrl: string, defaultBranch: string | undefined, account: string): SourceItem => {
    const p = priorityOf(i.labels);
    const context = [
      '[hopper issue context]',
      `forge: GitLab · project: ${i.project} · issue: #${i.iid} · url: ${i.url}`,
      `labels: ${i.labels.join(', ')} · author: ${i.author}`,
      `priority: ${p.priority} (${p.reason})`,
      gitlabLine(baseUrl),
      CHECKS_LINE.replace(/pull request/g, 'merge request'),
      gitlabDoneLine(i.iid, defaultBranch, i.title),
    ].join('\n');
    return {
      key: i.url, url: i.url, title: i.title, body: i.description,
      prompt: `${untrustedBlock({ title: i.title, body: i.description }, [], 0)}\n\n${context}`,
      env: { HOPPER_ISSUE_URL: i.url, HOPPER_REPO: i.project, HOPPER_ISSUE_NUMBER: String(i.iid), HOPPER_ISSUE_TITLE: oneLine(i.title) },
      author: i.author, assignee: account, priority: p.priority, priorityReason: p.reason,
      labels: i.labels, repo: i.project, number: i.iid,
      executor: o.executor ?? 'herdr-claude', ...(o.model ? { model: o.model } : {}),
      ...(i.description.trim() === '' ? { invalid: 'empty issue body' } : {}),
    };
  };

  /** Why an issue is not taken before its origin is read; undefined: it may be. */
  const notTaken = (i: GitLabIssue, account: string): Pick<IntakeOutcome, 'reason' | 'group'> | undefined => {
    const ended = END_LABELS.find((l) => i.labels.includes(l));
    if (ended) return { reason: `labelled ${ended}: remove the label at GitLab to offer it again`, group: 'other' };
    if (i.labels.includes(LABEL_BACKBURNER)) return { reason: `on the backburner (${LABEL_BACKBURNER})`, group: 'backburner' };
    if (!i.assignees.some((a) => same(a, account))) return { reason: `not assigned to your GitLab account ${account}: assign it at GitLab`, group: 'not-assigned' };
    return undefined;
  };

  /** The issue's origin: trusted, approved, or its request card. */
  async function originOf(i: GitLabIssue, account: string): Promise<GitLabVerdict> {
    const [events, notes] = await o.account.act((a) => Promise.all([a.labelEvents(i.project, i.iid), a.systemNotes(i.project, i.iid)]));
    const acts = gitlabActs(i, events, notes, label, account);
    const high = i.labels.includes(LABEL_HIGH) ? labelledBy(events, LABEL_HIGH) : undefined;
    const trusted = await o.account.trusted([...acts, ...(high ? [high] : [])].flatMap((a) => (a.userId === undefined ? [] : [a.userId])));
    return gitlabVerdict(i, acts, untrustedActs(acts, trusted), trusted, trust, high);
  }

  /** A card a rule approves (issue #1642, as GitHub's, issue #1268): recorded as the hopper's approval; the next sync takes it. */
  const autoApproved = (i: GitLabIssue, v: Extract<GitLabVerdict, { request: unknown }>): Pick<IntakeOutcome, 'reason' | 'group'> | undefined => {
    const guarded = trust.declined(i.url, v.request.hash) || trust.takenIn?.(i.url) === true;
    const found = trust.autoApprove ? gitlabAutoApproval(v, guarded, trust.autoApproval?.()) : undefined;
    if (!found) return undefined;
    trust.autoApprove!(o.name, i.url, { title: v.request.title, body: v.request.body, comments: [] }, v.request, found);
    return { reason: autoApprovedReason(found), group: 'other' };
  };

  return {
    name: o.name,
    kind: GITLAB_SOURCE_KIND,
    describe() {
      const s = o.account.status();
      const connected = 'account' in s ? { login: s.account, baseUrl: s.baseUrl, projects: s.projects } : {};
      return { ...connected, label, issues: outcomes.length, ...(Object.keys(repoErrors).length ? { repoErrors } : {}), ...(Object.keys(checkErrors).length ? { checkErrors } : {}) };
    },
    paused: () => o.account.paused(),
    async discover(): Promise<SourceItem[]> {
      const s = o.account.status();
      const clear = (): SourceItem[] => { outcomes = []; repoErrors = {}; return []; };
      if (s.state !== 'connected') return clear();
      const items: SourceItem[] = [];
      const listed: IntakeOutcome[] = [];
      const requests = new Map<string, IntakeRequest>();
      const errors: Record<string, string> = {};
      for (const project of s.projects) {
        try {
          const issues = await o.account.issues(project, label);
          let branch: { name: string | undefined } | undefined;
          for (const i of issues) {
            const base = { key: i.url, title: i.title, repo: i.project };
            const out = notTaken(i, s.account);
            if (out) { listed.push({ ...base, ...out }); continue; }
            let v: GitLabVerdict;
            try { v = await originOf(i, s.account); } catch (err) {
              if (o.account.status().state !== 'connected') throw err;
              listed.push({ ...base, reason: `its origin cannot be read: ${(err as Error).message}`, group: 'other' });
              continue;
            }
            if ('request' in v) {
              const auto = autoApproved(i, v);
              if (auto) listed.push({ ...base, ...auto }); else { requests.set(i.url, v.request); listed.push(requestOutcome(base, v.request, trust)); }
              continue;
            }
            branch ??= { name: await o.account.act((a) => a.defaultBranch(project)) };
            items.push({ ...toItem(i, s.baseUrl, branch.name, s.account), origin: v.origin, originActs: v.acts });
            listed.push(base);
          }
        } catch (err) {
          errors[project] = (err as Error).message;
          if (o.account.status().state !== 'connected') break; // its token ended: the rest would be refused too
        }
      }
      if (o.account.status().state !== 'connected') return clear(); // ended now: paused from the next sync
      outcomes = listed; repoErrors = errors;
      for (const [key, hash] of [...fresh]) if (requests.get(key)?.hash !== hash) fresh.delete(key);
      if (o.intake) {
        openRequests(o.name, o.intake, requests, opened);
        withdrawRequests(o.name, o.intake, requests, { repos: s.projects, repoErrors: errors }, opened, (key) => projectOfKey(s.baseUrl, key));
      }
      const projects = s.projects.length;
      if (projects > 0 && Object.keys(errors).length === projects) throw new Error(`GitLab answered no project: ${Object.values(errors)[0]}`);
      return items;
    },
    intake: () => takenOn(outcomes, fresh),
    intakeAction: async (a) => gitlabIntakeAct({ source: o.name, offered: takenOn(outcomes, fresh), trust, approved: (key, hash) => fresh.set(key, hash) }, a),
    async check(active: Job[]): Promise<SourceSignal[]> {
      if (o.account.status().state !== 'connected' || !active.some((j) => j.source?.source === o.name)) { checkErrors = {}; return []; }
      const r = await o.account.act((a) => checkJobs(a, o.name, label, active));
      checkErrors = r.errors;
      return r.signals;
    },
    notComplete: (job) => o.account.act((a) => notComplete(a, job, done)),
    mergesOnReady: (project) => yolo(project),
    follow: (job, act, at) => o.account.act((a) => followMergeRequest({
      api: a, yolo: yolo(job.source?.repo ?? ''), now: (o.clock?.now() ?? new Date()).getTime(), hold: (m) => mergeRequestHold(a, job, m, done),
    }, job, act, at)),
    async report(r) {
      const before = r.job.sourceState?.source ?? {};
      const project = r.job.source?.repo, iid = r.job.source?.number;
      if (project === undefined || iid === undefined) throw new SourceError(`job ${r.job.id} names no GitLab issue`, true);
      if (r.kind === 'finished') return gitlabCall(() => o.account.act(async (a) => finished(a, project, iid, before)));
      const change = r.kind === 'claimed' ? { add: [LABEL_CLAIMED], remove: [] }
        : r.kind === 'failed' && r.fixing ? { add: [], remove: [] } : unreadEnd(r.kind);
      await gitlabCall(() => o.account.act((a) => relabel(a, project, iid, change)));
      return { ...before, reported: r.kind };
    },
  };
}
