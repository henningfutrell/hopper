// Pending approvals in the UI (issue #2088), pure: whether an answer is the view, and the count on the nav entry with its
// title. Every pending approval counts, a stale one too: it still waits on the person, who approves or rejects it on GitHub.
import type { PendingApprovalsView } from '../../../src/domain/types.ts';
import type { NavBadge } from './nav-groups';

/** An answer is the view only with its lists; anything else is refused, never read as nothing waits. */
export const isPendingApprovalsView = (v: unknown): v is PendingApprovalsView => {
  const o = v as Partial<PendingApprovalsView> | null | undefined;
  return !!o && Array.isArray(o.approvals) && Array.isArray(o.orgs) && Array.isArray(o.problems);
};

/** The nav entry's count: how many wait on the person, and how many of them are stale. */
export function pendingApprovalsBadge(v: unknown): NavBadge {
  const approvals = isPendingApprovalsView(v) ? v.approvals : [];
  const n = approvals.length, stale = approvals.filter((a) => a.stale).length;
  return { n, cls: 'bg-warn text-background', title: `${n} deployment ${n === 1 ? 'approval waits' : 'approvals wait'} on you${stale > 0 ? ` (${stale} stale)` : ''}` };
}
