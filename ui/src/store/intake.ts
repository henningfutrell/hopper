// Intake actions in the store (issue #811). An intake action's answer names the keys it did not do: `intakeRefusal` makes
// that a failure, not a success toast. Approve on a request card: each approval this page sent, by the issue's key —
// waiting for the daemon, which records the approval and answers, then syncs the source after (issue #1194); done; or
// refused, with why.
// Intake reads it (issue #897): the button waits at once and sends once, a refusal shows on the card, and an approved
// issue stays where it was. Decline (issue #1035) is kept the same way: a person's decision on the card.
// The daemon is the source of truth (issue #1178): each decision keeps the hash of the text it decided, and the source's
// list resets it when it asks again — a request card with other text, or one with no approved text — or when the item's
// job ended, so a card never hides Approve on an old decision and an item that is done never stays in Needs approval.
// A refusal stays when the card's text changes (issue #1316): it says why the new text shows, until the next decision.
import { create } from 'zustand';
import type { IntakeActionResult, IntakeOutcome } from '../../../src/domain/intake.ts';
import { jobEnded } from '@/model/intake';
import type { JobStatus } from '@/model/wire';
import { actFor } from './index';

export type Approval = { hash: string } & (
  { state: 'pending' } | { state: 'approved' } | { state: 'declining' } | { state: 'declined' } | { state: 'refused'; error: string });

export const useApprovals = create<Record<string, Approval>>(() => ({}));

/** Why an intake action did not do these keys (its answer's `failed`), or undefined when it did them all. */
export const intakeRefusal = (keys: string[]) => (answer: unknown): string | undefined => {
  const failed = (answer as Partial<IntakeActionResult> | null)?.failed ?? {};
  const why = keys.flatMap((k) => (failed[k] === undefined ? [] : [failed[k]]));
  return why.length ? why.join('; ') : undefined;
};

/** A decision on the card that waits for the daemon. */
export const waitsForDaemon = (a: Approval | undefined): boolean => a?.state === 'pending' || a?.state === 'declining';

/**
 * An approve the daemon did not do because the issue is already taken — approved elsewhere since the page loaded, or of a
 * trusted origin (issue #1045): the daemon says `already approved` or `already taken`. The issue is taken, so it is no refusal.
 */
const alreadyTaken = (why: string): boolean => why.startsWith('already ');

async function decide(source: string, key: string, hash: string, kind: 'approve' | 'decline'): Promise<void> {
  if (waitsForDaemon(useApprovals.getState()[key])) return;
  const put = (a: Approval) => useApprovals.setState({ [key]: a });
  put({ hash, state: kind === 'approve' ? 'pending' : 'declining' });
  const r = await actFor(`/ui/api/sources/${encodeURIComponent(source)}/intake`, { kind, keys: [key], hash }, kind === 'approve' ? 'Approved' : 'Declined', (answer) => {
    const why = intakeRefusal([key])(answer);
    return why !== undefined && kind === 'approve' && alreadyTaken(why) ? undefined : why;
  });
  put(r.ok ? { hash, state: kind === 'approve' ? 'approved' : 'declined' } : { hash, state: 'refused', error: r.error });
}

/** Approves the request card's text; a second click while one waits sends nothing. */
export const approveRequest = (source: string, key: string, hash: string): Promise<void> => decide(source, key, hash, 'approve');

/** Declines the request card's text (issue #1035); a second click while one waits sends nothing. */
export const declineRequest = (source: string, key: string, hash: string): Promise<void> => decide(source, key, hash, 'decline');

/** A decision that keeps its issue in place: one waiting (the sync it runs can list the issue taken first) or done. */
export const keepsPlace = (a: Approval | undefined): boolean => a !== undefined && a.state !== 'refused';

/** Forgets the decisions that ended, when the list that showed them closes; one still waiting stays. */
export const forgetEndedApprovals = (): void =>
  useApprovals.setState((s) => Object.fromEntries(Object.entries(s).filter(([, a]) => waitsForDaemon(a))), true);

/**
 * Whether the daemon's list makes an ended decision stale (issue #1178). One still waiting is never stale: the list can
 * arrive before the daemon answers. The item's job ended: it is done, so it needs no decision. The list asks for a decision
 * again — a request card whose text hashes otherwise, or, for an approve or a decline, one with no approved text (the
 * daemon keeps no approval of it: the issue was reopened, say) —: the old decision is not the daemon's. A refusal is not
 * stale then (issue #1316): it says why the card shows other text.
 */
export function staleApproval(a: Approval, x: IntakeOutcome, jobStatusNow?: JobStatus): boolean {
  if (waitsForDaemon(a)) return false;
  if (jobEnded(jobStatusNow ?? x.jobStatus)) return true;
  if (x.action !== 'approve' || !x.request || a.state === 'refused') return false;
  return x.request.hash !== a.hash || !x.request.approved;
}

/** Forgets each decision the daemon's list makes stale (issue #1178); `jobStatus` gives a job's status as the UI knows it now. */
export function reconcileApprovals(items: IntakeOutcome[], jobStatus: (id: string) => JobStatus | undefined = () => undefined): void {
  const s = useApprovals.getState();
  const stale = items.filter((x) => s[x.key] !== undefined && staleApproval(s[x.key]!, x, x.jobId ? jobStatus(x.jobId) : undefined)).map((x) => x.key);
  if (stale.length) useApprovals.setState((now) => Object.fromEntries(Object.entries(now).filter(([k]) => !stale.includes(k))), true);
}
