// Merge now and Close PR in the store (issue #1194): the daemon answers once its checks pass, and the job's source merges
// or closes the pull request after. Each act this page sent, by the job's id, until the stream says how it ended:
// `job.pull_request_merged`, `job.pull_request_closed`, or `job.pull_request_act_failed` with why. Meanwhile the card's
// buttons wait and send nothing.
import { create } from 'zustand';
import { toast } from 'sonner';
import type { DomainEvent } from '@/model/wire';
import { actFor } from './index';

export type PullRequestAct = 'merge' | 'close';

export const useActingOnPullRequest = create<Record<string, PullRequestAct>>(() => ({}));

/** What the button says while the act runs. */
export const ACTING: Record<PullRequestAct, string> = { merge: 'Merging', close: 'Closing' };
const SENT: Record<PullRequestAct, string> = { merge: 'Merging: GitHub merges it now', close: 'Closing: GitHub closes it now' };
const ENDS: Record<string, PullRequestAct> = { 'job.pull_request_merged': 'merge', 'job.pull_request_closed': 'close' };
const DONE: Record<PullRequestAct, string> = { merge: 'Merged', close: 'Closed without a merge' };

const onEnd = new Map<string, () => void>();

const drop = (jobId: string) => {
  useActingOnPullRequest.setState((s) => Object.fromEntries(Object.entries(s).filter(([id]) => id !== jobId)), true);
  const then = onEnd.get(jobId);
  onEnd.delete(jobId);
  then?.();
};

/** Sends the act on the job's pull request; true once the daemon took it. A second click while one runs sends nothing. */
export async function actOnPullRequest(jobId: string, act: PullRequestAct, ended?: () => void): Promise<boolean> {
  if (useActingOnPullRequest.getState()[jobId]) return false;
  useActingOnPullRequest.setState({ [jobId]: act });
  if (ended) onEnd.set(jobId, ended);
  const r = await actFor(`/ui/api/pull-requests/${act}`, { jobId });
  if (!r.ok) { drop(jobId); return false; }
  // The stream may have said how it ended before the answer came.
  if (useActingOnPullRequest.getState()[jobId] === act) toast(SENT[act]);
  return true;
}

/** A stream event that ends an act this page sent: merged or closed, or the act failed, with why. */
export function onPullRequestActEvent(e: DomainEvent): void {
  const act = e.jobId === undefined ? undefined : useActingOnPullRequest.getState()[e.jobId];
  if (!act || !e.jobId) return;
  if (ENDS[e.type]) { drop(e.jobId); toast.success(DONE[ENDS[e.type]!]); }
  if (e.type === 'job.pull_request_act_failed') { drop(e.jobId); toast.error(`${act === 'merge' ? 'Merge now' : 'Close PR'} failed: ${String(e.data.error)}`); }
}
