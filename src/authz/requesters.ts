// Requesters in Access (issue #581), pure: whether a requester — a job, a machine or a user — may ask now and the
// template it runs as, how a decision names it, and the permission matrix's rows, from who is live and the hopper's rows.
import type { TrustLevel } from '../domain/trust-stamp.ts';
import type { LiveRequesters, OperationProfile, RelationshipTuple, Requester, RequesterRow } from '../domain/types.ts';
import { requesterObject } from './objects.ts';
import { trustedPath } from './trust.ts';

/** Why the requester may not ask now (its job not live, its machine no box, no such user), or the template and machine it runs as. */
export function standing(
  live: readonly LiveRequesters[], r: Requester, jobStatus: (userId: string, jobId: string) => string | undefined,
): { problem: string } | { template?: string; machine?: string } {
  const jobNotLive = (jobId: string) => ({ problem: `job ${jobId} is not live (${jobStatus(r.userId, jobId) ?? 'no such job'})` });
  const mine = live.find((l) => l.userId === r.userId);
  if (!mine) return r.kind === 'job' ? jobNotLive(r.jobId) : { problem: `no user ${r.userId}` };
  const templateOf = (machine: string | undefined) => mine.boxes.find((b) => b.machine === machine)?.template;
  if (r.kind === 'user') return {};
  if (r.kind === 'machine') {
    const template = templateOf(r.machine);
    return template === undefined ? { problem: `machine ${r.machine} is no box of a template` } : { template };
  }
  const job = mine.jobs.find((j) => j.jobId === r.jobId);
  if (!job) return jobNotLive(r.jobId);
  const template = templateOf(job.machine);
  return { ...(template === undefined ? {} : { template }), ...(job.machine === undefined ? {} : { machine: job.machine }) };
}

/** The requester as recorded: its own fields, nothing else a caller passed. */
export function requesterCopy(r: Requester): Requester {
  if (r.kind === 'job') return { kind: r.kind, userId: r.userId, jobId: r.jobId };
  if (r.kind === 'machine') return { kind: r.kind, userId: r.userId, machine: r.machine };
  return { kind: r.kind, userId: r.userId };
}

/** How a reason names the requester: by its template when it runs as one, else by itself, a user by its email when it has one (issue #1380). */
export function requesterText(r: Requester, template: string | undefined, email?: string): string {
  if (template !== undefined) return `template ${template}`;
  return r.kind === 'job' ? `job ${r.jobId}` : r.kind === 'machine' ? `machine ${r.machine}` : `user ${email ?? r.userId}`;
}

/** The template a path goes through, or undefined. */
export const templateOnPath = (path: readonly RelationshipTuple[] | undefined): string | undefined =>
  path?.find((t) => t.relation === 'approved_for')?.subject.replace(/^template:/, '');

/** Every user, then each of their live jobs and boxes, each with the profiles it reaches through `tuples` (the hopper's reading), each path's tuples as `shown` gives them (a person by their email, issue #1380). */
export function requesterRows(
  live: readonly LiveRequesters[], tuples: readonly RelationshipTuple[], profiles: readonly OperationProfile[], shown: (t: RelationshipTuple) => RelationshipTuple = (t) => t,
): RequesterRow[] {
  const row = (requester: Requester, at: { template?: string; machine?: string; trust?: TrustLevel } = {}): RequesterRow => ({
    requester, ...at,
    grants: profiles.flatMap((profile) => {
      const path = trustedPath(tuples, requesterObject(requester), profile);
      return path ? [{ profile, path: path.map(shown) }] : [];
    }),
  });
  return live.flatMap((l) => {
    const templateOf = (machine: string | undefined) => l.boxes.find((b) => b.machine === machine)?.template;
    return [
      row({ kind: 'user', userId: l.userId }),
      ...l.jobs.map((j) => {
        const template = templateOf(j.machine);
        return row({ kind: 'job', userId: l.userId, jobId: j.jobId }, {
          ...(template === undefined ? {} : { template }), ...(j.machine === undefined ? {} : { machine: j.machine }), ...(j.trust === undefined ? {} : { trust: j.trust }),
        });
      }),
      ...l.boxes.map((b) => row({ kind: 'machine', userId: l.userId, machine: b.machine }, { template: b.template })),
    ];
  });
}
