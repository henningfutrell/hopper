// Run again and Rework in the store (issue #1194). The daemon answers once its checks pass, and the job's source gives
// the item back after (on GitHub: the issue reopened and its end labels gone; for Rework, the pull request made a draft
// first). Each give-back this page sent, by the ended job's id, until the stream says how it ended: the new job
// (`job.rerun`, `job.rework_requested`), or `job.give_back_failed` with why. Meanwhile the button waits and sends nothing.
import { create } from 'zustand';
import { toast } from 'sonner';
import type { DomainEvent } from '@/model/wire';
import { actFor } from './index';

export type GiveBackAct = 'rerun' | 'rework';

export const useGivingBack = create<Record<string, GiveBackAct>>(() => ({}));

const NAME: Record<GiveBackAct, string> = { rerun: 'Run again', rework: 'Rework' };
const SENT: Record<GiveBackAct, string> = { rerun: 'Running again: its issue is given back on GitHub first', rework: 'Sending back: its pull request is made a draft first' };
const DONE: Record<GiveBackAct, string> = { rerun: 'Queued again', rework: 'Sent back for rework: the new job is queued' };

const drop = (jobId: string) => useGivingBack.setState((s) => Object.fromEntries(Object.entries(s).filter(([id]) => id !== jobId)), true);

/** Sends Run again or Rework for the ended job; true once the daemon took it. A second click while one runs sends nothing. */
export async function giveBack(jobId: string, act: GiveBackAct, body: unknown = {}): Promise<boolean> {
  if (useGivingBack.getState()[jobId]) return false;
  useGivingBack.setState({ [jobId]: act });
  const r = await actFor(`/ui/api/jobs/${jobId}/${act}`, body);
  if (!r.ok) { drop(jobId); return false; }
  // The stream may have said how it ended before the answer came.
  if (useGivingBack.getState()[jobId] === act) toast(SENT[act]);
  return true;
}

/** A stream event that ends a give-back this page sent: the new job queued, or the give-back failed, with why. */
export function onGiveBackEvent(e: DomainEvent): void {
  const act = e.jobId === undefined ? undefined : useGivingBack.getState()[e.jobId];
  if (!act || !e.jobId) return;
  if (e.type === 'job.rerun' || e.type === 'job.rework_requested') { drop(e.jobId); toast.success(DONE[act]); }
  if (e.type === 'job.give_back_failed') { drop(e.jobId); toast.error(`${NAME[act]} failed: ${String(e.data.error)}`); }
}
