// Action grants (issue #2206, design.md "Action grants"): one user's grants, kept in their settings (`actionGrants`), and
// the asks of their jobs, read from the event log — a `vault.action_asked` of a job at work that no live grant covers and
// no person declined —, so an ask outlives a restart of the hopper and needs no state of its own. A person grants,
// declines or revokes through the UI session (src/http/ui/action-grants.ts); a job only asks, through its need step.
import {
  actionInWords, granting, liveGrants, revoking, ungranted, type ActionAskView, type ActionGrant, type ActionGrantView, type AwsAction,
} from '../domain/action-grants.ts';
import type { UserStore } from '../domain/ports.ts';
import { rememberHoursOf } from '../domain/remembered-writes.ts';
import type { DomainEvent } from '../domain/types.ts';
import { AT_WORK } from './box.ts';

type Store = Pick<UserStore, 'settings' | 'events' | 'jobs'>;
/** One grant's scope: the aws-role (`<account>/<role>`), the action and its resource. */
export type ActionScope = AwsAction & { role: string };

/** How far back the asks of jobs at work are read. */
const ASKS_DAYS = 7;
const ASK_TYPES = ['vault.action_asked', 'vault.action_declined'] as const;

const sameScope = (a: ActionScope, d: Record<string, unknown>): boolean => d.role === a.role && d.action === a.action && d.resource === a.resource;
const scopeOf = (d: Record<string, unknown>): ActionScope => ({ role: String(d.role), action: String(d.action), resource: String(d.resource) });

/** The grants not ended now, each with its end: the time limit of remembered write approvals (issue #1001). */
export const grantsNow = (store: Pick<UserStore, 'settings'>, now: Date): ActionGrantView[] =>
  liveGrants(store.settings.getActionGrants(), rememberHoursOf(store.settings.getSandboxApprovals()), now);

/** The actions of `role` that no live grant covers now. */
export const notGranted = (store: Pick<UserStore, 'settings'>, role: string, actions: readonly AwsAction[], now: Date): AwsAction[] =>
  ungranted(grantsNow(store, now), role, actions);

/** What a step's ask of actions comes to: all granted, some waiting for a person, or one a person declined. */
export type ActionAnswer = { granted: true } | { waiting: AwsAction[] } | { declined: string };

/**
 * A job's need step asks for `actions` on `role`: each that no live grant covers and the job did not ask for before is a
 * `vault.action_asked`, for a person; one a person declined for this job is a no, with their reason.
 */
export function askActions(store: Store, job: string, role: string, actions: readonly AwsAction[], why: string | undefined, now: Date): ActionAnswer {
  const missing = notGranted(store, role, actions, now);
  if (missing.length === 0) return { granted: true };
  const before = store.events.recent(500, [...ASK_TYPES], job);
  for (const a of missing) {
    const scope = { ...a, role };
    const declined = before.find((e) => e.type === 'vault.action_declined' && sameScope(scope, e.data as Record<string, unknown>));
    if (declined) {
      const reason = (declined.data as { reason?: string }).reason;
      return { declined: `a person declined ${actionInWords(scope)}${reason ? `: ${reason}` : ''}. Find another way, or ask a person` };
    }
  }
  for (const a of missing) {
    const scope = { ...a, role };
    if (before.some((e) => e.type === 'vault.action_asked' && sameScope(scope, e.data as Record<string, unknown>))) continue;
    store.events.append({ type: 'vault.action_asked', jobId: job, data: { job, ...scope, ...(why ? { why } : {}) } });
  }
  return { waiting: missing };
}

/** The asks that wait for a person: of jobs at work, not declined, and not covered by a grant now; newest first. */
export function actionAsks(store: Store, now: Date): ActionAskView[] {
  const events: DomainEvent[] = store.events.between([...ASK_TYPES], new Date(now.getTime() - ASKS_DAYS * 86_400_000).toISOString());
  const live = grantsNow(store, now);
  const out = new Map<string, ActionAskView>();
  for (const e of events) {
    const d = e.data as Record<string, unknown>, job = String(d.job), scope = scopeOf(d);
    const key = `${job} ${scope.role} ${scope.action} ${scope.resource}`;
    if (e.type === 'vault.action_declined') { out.delete(key); continue; }
    const j = store.jobs.get(job);
    if (!j || !AT_WORK.includes(j.status) || ungranted(live, scope.role, [scope]).length === 0) { out.delete(key); continue; }
    const title = j.source?.title ?? j.spec.goal, url = j.source?.url;
    out.set(key, { job, ...scope, at: e.at, ...(typeof d.why === 'string' ? { why: d.why } : {}), ...(title ? { jobTitle: title } : {}), ...(url ? { jobUrl: url } : {}) });
  }
  return [...out.values()].reverse();
}

/** A person grants `scope`, answering `job`'s ask when it names one: kept, and `vault.action_granted` on the job's timeline. */
export function grantAction(store: Store, scope: ActionScope, by: string, now: Date, job?: string): void {
  const g: ActionGrant = { ...scope, by, at: now.toISOString() };
  store.settings.setActionGrants(granting(store.settings.getActionGrants(), g, now, rememberHoursOf(store.settings.getSandboxApprovals())));
  store.events.append({ type: 'vault.action_granted', ...(job ? { jobId: job } : {}), data: { ...(job ? { job } : {}), ...scope, by } });
}

/** A person declines `job`'s ask of `scope`: its step is told no. */
export function declineAction(store: Store, scope: ActionScope, job: string, by: string, reason?: string): void {
  store.events.append({ type: 'vault.action_declined', jobId: job, data: { job, ...scope, ...(reason ? { reason } : {}), by } });
}

/** A person revokes the grant of `scope`; false: there is none. */
export function revokeAction(store: Store, scope: ActionScope, by: string): boolean {
  const list = store.settings.getActionGrants(), kept = revoking(list, scope);
  if (kept.length === list.length) return false;
  store.settings.setActionGrants(kept);
  store.events.append({ type: 'vault.action_revoked', data: { ...scope, by } });
  return true;
}
