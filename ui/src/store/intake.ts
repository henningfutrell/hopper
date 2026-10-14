// Intake actions in the store (issue #811). An intake action's answer names the keys it did not do: `intakeRefusal` makes
// that a failure, not a success toast. Approve on a request card: each approval this page sent, by the issue's key —
// waiting for the daemon, which approves and then syncs the source, so it takes seconds; done; or refused, with why.
// Intake reads it (issue #897): the button waits at once and sends once, a refusal shows on the card, and an approved
// issue stays where it was. Decline (issue #1035) is kept the same way: a person's decision on the card.
import { create } from 'zustand';
import type { IntakeActionResult } from '../../../src/domain/intake.ts';
import { actFor } from './index';

export type Approval = { state: 'pending' } | { state: 'approved' } | { state: 'declining' } | { state: 'declined' } | { state: 'refused'; error: string };

export const useApprovals = create<Record<string, Approval>>(() => ({}));

/** Why an intake action did not do these keys (its answer's `failed`), or undefined when it did them all. */
export const intakeRefusal = (keys: string[]) => (answer: unknown): string | undefined => {
  const failed = (answer as Partial<IntakeActionResult> | null)?.failed ?? {};
  const why = keys.flatMap((k) => (failed[k] === undefined ? [] : [failed[k]]));
  return why.length ? why.join('; ') : undefined;
};

/** A decision on the card that waits for the daemon. */
export const waitsForDaemon = (a: Approval | undefined): boolean => a?.state === 'pending' || a?.state === 'declining';

async function decide(source: string, key: string, hash: string, kind: 'approve' | 'decline'): Promise<void> {
  if (waitsForDaemon(useApprovals.getState()[key])) return;
  const put = (a: Approval) => useApprovals.setState({ [key]: a });
  put({ state: kind === 'approve' ? 'pending' : 'declining' });
  const r = await actFor(`/ui/api/sources/${encodeURIComponent(source)}/intake`, { kind, keys: [key], hash }, kind === 'approve' ? 'Approved' : 'Declined', intakeRefusal([key]));
  put(r.ok ? { state: kind === 'approve' ? 'approved' : 'declined' } : { state: 'refused', error: r.error });
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
