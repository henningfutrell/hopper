// The acts that give an ended job's item back, in the store (issue #1194): Run again, Rework, Failures' Retry, a
// hand-off's Continue and I fixed it, Push it and Tend again. The daemon answers once its checks pass, and the job's
// source gives the item back after (on GitHub: the issue reopened and its end labels gone; for Rework, the pull request
// made a draft first). Each give-back this page sent, by the ended job's id, until the stream says how it ended: the new
// job or the job going on (`job.rerun`, `job.rework_requested`, `job.continued`, `job.pull_request_tended`), or
// `job.give_back_failed` with why. Meanwhile the button waits and sends nothing.
import { create } from 'zustand';
import { toast } from 'sonner';
import type { DomainEvent } from '@/model/wire';
import { actFor } from './index';

export type GiveBackAct = 'rerun' | 'rework' | 'retry' | 'continue' | 'fixed' | 'push' | 'tend';

export const useGivingBack = create<Record<string, GiveBackAct>>(() => ({}));

const NAME: Record<GiveBackAct, string> = {
  rerun: 'Run again', rework: 'Rework', retry: 'Retry', continue: 'Continue', fixed: 'I fixed it', push: 'Push it', tend: 'Tend again',
};
const SENT: Record<GiveBackAct, string> = {
  rerun: 'Running again: its issue is given back on GitHub first',
  rework: 'Sending back: its pull request is made a draft first',
  retry: 'Running it again: its issue is given back on GitHub first',
  continue: 'Going on: its issue is given back on GitHub first',
  fixed: 'Running it again: its issue is given back on GitHub first',
  push: 'Going on to push its work: its issue is given back on GitHub first',
  tend: 'Tending again: its issue is given back on GitHub first',
};
const DONE: Record<GiveBackAct, string> = {
  rerun: 'Queued again', rework: 'Sent back for rework: the new job is queued', retry: 'Queued again', continue: 'The job goes on',
  fixed: 'Queued again', push: 'The job goes on to push its work', tend: 'The new tend job is queued',
};
/** What the button says while the give-back runs. */
export const PENDING: Record<GiveBackAct, string> = {
  rerun: 'Running again', rework: 'Sending back', retry: 'Running again', continue: 'Going on', fixed: 'Running again', push: 'Pushing', tend: 'Tending again',
};
/** The stream events that end a give-back well. */
const ENDS = new Set(['job.rerun', 'job.rework_requested', 'job.continued', 'job.pull_request_tended']);

/** What a view does once the give-back it sent ended, well or not: read its list again. */
const onEnd = new Map<string, () => void>();

const drop = (jobId: string) => {
  useGivingBack.setState((s) => Object.fromEntries(Object.entries(s).filter(([id]) => id !== jobId)), true);
  const then = onEnd.get(jobId);
  onEnd.delete(jobId);
  then?.();
};

/**
 * Sends the act for the ended job `jobId` to `path` (Run again and Rework: the job's own route); true once the daemon
 * took it. A second click while one runs sends nothing. `ended`: called once the stream says how it ended.
 */
export async function giveBack(jobId: string, act: GiveBackAct, o: { path?: string; body?: unknown; ended?: () => void } = {}): Promise<boolean> {
  if (useGivingBack.getState()[jobId]) return false;
  useGivingBack.setState({ [jobId]: act });
  if (o.ended) onEnd.set(jobId, o.ended);
  const r = await actFor(o.path ?? `/ui/api/jobs/${jobId}/${act}`, o.body ?? {});
  if (!r.ok) { drop(jobId); return false; }
  // The stream may have said how it ended before the answer came.
  if (useGivingBack.getState()[jobId] === act) toast(SENT[act]);
  return true;
}

/** A stream event that ends a give-back this page sent: the new job queued or the job going on, or the give-back failed, with why. */
export function onGiveBackEvent(e: DomainEvent): void {
  const act = e.jobId === undefined ? undefined : useGivingBack.getState()[e.jobId];
  if (!act || !e.jobId) return;
  if (ENDS.has(e.type)) { drop(e.jobId); toast.success(DONE[act]); }
  if (e.type === 'job.give_back_failed') { drop(e.jobId); toast.error(`${NAME[act]} failed: ${String(e.data.error)}`); }
}
