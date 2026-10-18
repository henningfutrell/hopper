// A GitLab job's merge request followed (issue #1642 part 2, design.md "A GitLab job's merge request"), as the GitHub source
// follows a pull request (`src/sources/github/follow.ts`), with less: no parts, no tending, no change kinds, no landing branch.
// The report of a done job keeps the newest ready merge request that closes its issue (`pullRequest`, `follow: open`) and
// labels the issue `hopper:pr-ready`; its issue closed already, `hopper:done`. Each follow reads that merge request: still
// open, what is seen of it — a draft, merge conflicts, its head pipeline as checks (`success` passing; `failed`, `canceled`
// failing; none: `none`; any other: pending) — is kept for the Pull requests list. With yolo mode on for its project, asked by
// the project's URL at its GitLab, the hopper merges it once ready (`readyToMerge`: not a draft, no merge conflicts, its
// pipeline passed, or none and none started within the grace window after its last change), at the head it read: the merge
// marker is kept first (issue #1588), so a stop before the record still records the hopper's merge. GitLab's refusal is kept
// on what is seen (`mergeError`) and asked again at the next follow. Merged: `hopper:done` in place of `hopper:pr-ready`;
// closed without a merge: `hopper:pr-closed`, which keeps the issue out until a person removes it. A person's Merge now and
// Close PR are not taken on GitLab yet: they act on GitLab. The job's done criteria (issue #1924 part 4) are read just before
// the hopper's merge: one not met, or a `person-merges` one that applies, holds it as `mergeError`, asked again at the next follow.
import { SourceError } from '../domain/ports.ts';
import { readyToMerge, type ChecksState, type FollowAt, type FollowUp, type Job, type MergeMarker, type PullRequestAct, type PullRequestSeen } from '../domain/types.ts';
import { LABEL_CLAIMED, LABEL_DONE, LABEL_FAILED, LABEL_PR_CLOSED, LABEL_PR_READY } from '../sources/github/labels.ts';
import { GitLabTokenRefused, type GitLabApi, type GitLabMergeRequest } from './api.ts';

interface Followed { pullRequest?: string; follow?: string; merging?: MergeMarker; seen?: PullRequestSeen; mergeChecked?: boolean }

export interface GitLabFollowContext {
  api: GitLabApi;
  /** Whether yolo mode is on for the job's project. */
  yolo: boolean;
  /** Now, in ms: the grace window of a merge request with no pipeline. */
  now: number;
  /** Why the hopper does not merge it itself by the job's done criteria (done-criteria.ts); absent, or undefined: no hold. */
  hold?: (m: GitLabMergeRequest) => Promise<string | undefined>;
}

/** A head pipeline's status as checks: absent, none. */
export function checksOf(pipeline: string | undefined): ChecksState | 'none' {
  if (!pipeline) return 'none';
  if (pipeline === 'success') return 'passing';
  return pipeline === 'failed' || pipeline === 'canceled' ? 'failing' : 'pending';
}

/** A merge request's number in its project, from its URL (`…/-/merge_requests/N`); 0: not such a URL. */
export const mergeRequestNumber = (url: string): number => Number(/\/-\/merge_requests\/(\d+)$/.exec(url)?.[1] ?? 0);

const newest = (list: readonly GitLabMergeRequest[]): GitLabMergeRequest | undefined => [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
const ready = (m: GitLabMergeRequest): boolean => m.state === 'opened' && !m.draft && !m.conflicting && checksOf(m.pipeline) !== 'failing';

/** What the report names to follow: the newest ready merge request that closes the issue; undefined: none yet. */
export async function readyMergeRequest(api: GitLabApi, project: string, iid: number): Promise<GitLabMergeRequest | undefined> {
  return newest((await api.closingMergeRequests(project, iid)).filter(ready));
}

/** The issue's labels at a done job's end (the report): `hopper:done` closed already, else `hopper:pr-ready`. */
export const endLabels = (closed: boolean) => ({ add: [closed ? LABEL_DONE : LABEL_PR_READY], remove: [LABEL_CLAIMED, LABEL_FAILED] });

const seenOf = (m: GitLabMergeRequest): PullRequestSeen => ({
  draft: m.draft, conflicting: m.conflicting, checks: checksOf(m.pipeline), openedAt: m.createdAt, pushedAt: m.updatedAt ?? m.createdAt,
  ...(m.target ? { base: m.target } : {}), ...(m.source ? { headRef: m.source } : {}),
});

/** The merge request a follow reads: the one kept, else the newest open one that closes the issue, else one merged since the job began. */
async function followedUrl(api: GitLabApi, job: Job, project: string, iid: number, kept: string | undefined): Promise<string | undefined> {
  if (kept) return kept;
  const list = await api.closingMergeRequests(project, iid);
  const since = Date.parse(job.createdAt);
  return (newest(list.filter((m) => m.state === 'opened')) ?? newest(list.filter((m) => m.state === 'merged' && Date.parse(m.mergedAt ?? '') >= since)))?.url;
}

/**
 * Follow the done job's merge request (JobSource.follow): undefined while nothing seen of it changed; open with what is seen
 * now; merged — by the hopper with yolo mode on, once ready — or closed without a merge. A throw is asked again later.
 */
export async function followMergeRequest(c: GitLabFollowContext, job: Job, act?: PullRequestAct, at?: FollowAt): Promise<FollowUp | undefined> {
  if (act) throw new SourceError(`${act === 'merge' ? 'Merge now' : 'Close PR'} is not taken on GitLab yet: do it on GitLab`, true);
  const s = (job.sourceState?.source ?? {}) as Followed & Record<string, unknown>;
  const { repo: project, number: iid } = job.source ?? {};
  if (!project || !iid) return undefined;
  if (s.follow === 'merged') return s.mergeChecked || !s.pullRequest ? undefined : { outcome: 'checked', pullRequest: s.pullRequest, part: false, state: { ...s, mergeChecked: true } };
  if (s.follow !== 'open') return undefined;
  const url = await followedUrl(c.api, job, project, iid, s.pullRequest);
  if (!url) return undefined;
  const { merging, seen: _seen, ...rest } = s;
  const labels = (add: string, remove: readonly string[]) => c.api.editLabels(project, iid, { add: [add], remove });
  const merged = async (marker: MergeMarker | undefined): Promise<FollowUp> => {
    await labels(LABEL_DONE, [LABEL_PR_READY, LABEL_CLAIMED, LABEL_FAILED]);
    return {
      outcome: 'merged', pullRequest: url, part: false, ...(marker?.byHopper ? { byHopper: true } : {}), ...(marker?.acting ? { acting: marker.acting } : {}),
      state: { ...rest, pullRequest: url, follow: 'merged', mergeChecked: true },
    };
  };
  const m = await c.api.mergeRequest(project, mergeRequestNumber(url));
  if (m.state === 'merged') return merged(merging?.pullRequest === url ? merging : undefined);
  if (m.state === 'closed') {
    await labels(LABEL_PR_CLOSED, [LABEL_PR_READY]);
    return { outcome: 'closed', pullRequest: url, part: false, state: { ...rest, pullRequest: url, follow: 'closed' } };
  }
  let seen = seenOf(m);
  const held = c.yolo && m.sha && readyToMerge(seen, c.now) ? await c.hold?.(m) : undefined;
  if (held !== undefined) seen = { ...seen, mergeError: held };
  else if (c.yolo && m.sha && readyToMerge(seen, c.now)) {
    const marker: MergeMarker = { pullRequest: url, head: m.sha, byHopper: true };
    at?.keep({ ...rest, pullRequest: url, merging: marker });
    try {
      await c.api.merge(project, m.iid, m.sha);
      return await merged(marker);
    } catch (err) {
      if (err instanceof GitLabTokenRefused) throw err;
      seen = { ...seen, mergeError: (err as Error).message };
    }
  }
  if (!merging && s.pullRequest === url && JSON.stringify(s.seen) === JSON.stringify(seen)) return undefined;
  return { outcome: 'open', pullRequest: url, part: false, state: { ...rest, pullRequest: url, seen } };
}
