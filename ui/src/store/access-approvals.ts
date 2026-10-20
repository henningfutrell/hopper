// Approvals on Access requests (issue #1018): a template card's and a run card's Approve, and Approve selected,
// which approves every card a person selected in one action. Each item's posts are sent at once, never one after
// another: an item waits only for its own answers, and a failure on one stops no other. Each item keeps its own state —
// waiting for the daemon, approved, or failed with why — which its card shows. Each answer is the vault's view, kept by
// viewAnswer (issue #1019), so answers that come back in any order leave no stale view. Issue #2197: a run card is one
// post, `approve-run`: the daemon approves its template, each profile it lists and its run in one action.
import { toast } from 'sonner';
import { create } from 'zustand';
import { post, RoleRefused, SessionRejected } from '@/lib/api';
import type { RunCardView, TemplateView, VaultView } from '@/model/wire';
import { allListed, runCardKey } from '@/model/vault';
import { useHopper } from './index';
import { viewAnswer } from './vault';

export type ItemApproval = { state: 'pending' } | { state: 'approved' } | { state: 'failed'; error: string };

/** One card's approval: its name for people, and the posts that approve it. */
export interface ApprovalItem { key: string; label: string; posts: { path: string; body: unknown }[] }

/** The last batch's count, for the Approve selected bar. */
export interface BatchResult { approved: number; failed: number }

export const useAccessApprovals = create<{ items: Record<string, ItemApproval>; selected: string[]; last: BatchResult | null }>(() => ({ items: {}, selected: [], last: null }));

/** A template card's key: a template saved again is a new item, with no state of the last one. */
export const templateKey = (t: TemplateView): string => `template:${t.name}@${t.savedAt}`;
/** A run card's key: a template saved again makes it a new item, with no state of the last one. */
export const runKey = (c: RunCardView, t?: Pick<TemplateView, 'savedAt'>): string => `run:${runCardKey(c)}@${t?.savedAt ?? ''}`;

/** The template as it is and each listed profile (Approve all listed). */
export const templateItem = (t: TemplateView): ApprovalItem => ({
  key: templateKey(t), label: t.name, posts: allListed(t).map((edit) => ({ path: '/ui/api/vault', body: edit })),
});
/**
 * The run card's one approval (issue #2197): its template as it is, each profile it lists, and its run; for this job's
 * runs only, or with `allowAgain` (part 3) for later jobs with the same needs too.
 */
export const runItem = (c: RunCardView, t?: Pick<TemplateView, 'savedAt' | 'label'>, allowAgain = false): ApprovalItem => ({
  key: runKey(c, t), label: t?.label ?? c.template,
  posts: [{ path: '/ui/api/sandbox-requests', body: { action: 'approve-run', job: c.jobId, template: c.template, ...(allowAgain ? { allowAgain: true } : {}) } }],
});

const put = (key: string, a: ItemApproval): void => useAccessApprovals.setState((s) => ({ items: { ...s.items, [key]: a } }));

const reasonOf = (e: unknown): string => {
  if (e instanceof SessionRejected) useHopper.setState({ authed: false });
  return e instanceof RoleRefused ? 'Only an admin does this' : (e as Error).message;
};

/** Sends one item's posts at once; its state is its own. True when all of them went through. */
async function approveOne(item: ApprovalItem): Promise<boolean> {
  const answers = await Promise.allSettled(item.posts.map((p) => viewAnswer(() => post<VaultView>(p.path, p.body))));
  const why = answers.flatMap((a) => (a.status === 'rejected' ? [reasonOf(a.reason)] : []));
  put(item.key, why.length ? { state: 'failed', error: why.join('; ') } : { state: 'approved' });
  return why.length === 0;
}

/** Approves each item at once, side by side; an item already waiting for the daemon is not sent again. */
export async function approveItems(items: readonly ApprovalItem[]): Promise<BatchResult> {
  const now = useAccessApprovals.getState();
  const fresh = items.filter((i) => now.items[i.key]?.state !== 'pending');
  if (fresh.length === 0) return { approved: 0, failed: 0 };
  const keys = new Set(fresh.map((i) => i.key));
  useAccessApprovals.setState((s) => ({
    items: { ...s.items, ...Object.fromEntries(fresh.map((i) => [i.key, { state: 'pending' } as const])) },
    selected: s.selected.filter((k) => !keys.has(k)),
  }));
  const done = await Promise.all(fresh.map(approveOne));
  const result = { approved: done.filter(Boolean).length, failed: done.filter((ok) => !ok).length };
  useAccessApprovals.setState({ last: result });
  const one = fresh.length === 1 ? fresh[0]! : undefined;
  if (one && result.approved) toast.success(`${one.label}: approved`);
  else if (one) toast.error(`${one.label}: ${(useAccessApprovals.getState().items[one.key] as { error?: string }).error ?? 'not approved'}`);
  else if (result.failed) toast.error(batchText(result));
  else toast.success(batchText(result));
  return result;
}

export const batchText = (r: BatchResult): string => (r.failed ? `${r.approved} approved, ${r.failed} failed` : `${r.approved} approved`);

/** Selects or unselects one card. */
export const toggleSelected = (key: string, on: boolean): void =>
  useAccessApprovals.setState((s) => ({ selected: on ? [...new Set([...s.selected, key])] : s.selected.filter((k) => k !== key) }));

export const selectOnly = (keys: string[]): void => useAccessApprovals.setState({ selected: keys });

/** Forgets the items that ended and the selection, when Access requests closes; one still waiting stays. */
export const forgetEndedItems = (): void =>
  useAccessApprovals.setState((s) => ({ items: Object.fromEntries(Object.entries(s.items).filter(([, a]) => a.state === 'pending')), selected: [], last: null }));
