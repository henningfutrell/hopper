// Intake actions in the store (issue #811). An intake action's answer names the keys it did not do: `intakeRefusal` makes
// that a failure, not a success toast. Approve on a request card: each approval this page sent, by the issue's key —
// waiting for the daemon, which approves and then syncs the source, so it takes seconds; done; or refused, with why.
// Intake reads it (issue #897): the button waits at once and sends once, a refusal shows on the card, and an approved
// issue stays where it was.
import { create } from 'zustand';
import type { IntakeActionResult } from '../../../src/domain/intake.ts';
import { actFor } from './index';

export type Approval = { state: 'pending' } | { state: 'approved' } | { state: 'refused'; error: string };

export const useApprovals = create<Record<string, Approval>>(() => ({}));

/** Why an intake action did not do these keys (its answer's `failed`), or undefined when it did them all. */
export const intakeRefusal = (keys: string[]) => (answer: unknown): string | undefined => {
  const failed = (answer as Partial<IntakeActionResult> | null)?.failed ?? {};
  const why = keys.flatMap((k) => (failed[k] === undefined ? [] : [failed[k]]));
  return why.length ? why.join('; ') : undefined;
};

/** Approves the request card's text; a second click while one waits sends nothing. */
export async function approveRequest(source: string, key: string, hash: string): Promise<void> {
  if (useApprovals.getState()[key]?.state === 'pending') return;
  const put = (a: Approval) => useApprovals.setState({ [key]: a });
  put({ state: 'pending' });
  const r = await actFor(`/ui/api/sources/${encodeURIComponent(source)}/intake`, { kind: 'approve', keys: [key], hash }, 'Approved', intakeRefusal([key]));
  put(r.ok ? { state: 'approved' } : { state: 'refused', error: r.error });
}

/** An approval that keeps its issue in place: one waiting (the sync it runs can list the issue taken first) or done. */
export const keepsPlace = (a: Approval | undefined): boolean => a?.state === 'pending' || a?.state === 'approved';

/** Forgets the approvals that ended, when the list that showed them closes; one still waiting stays. */
export const forgetEndedApprovals = (): void =>
  useApprovals.setState((s) => Object.fromEntries(Object.entries(s).filter(([, a]) => a.state === 'pending')), true);
