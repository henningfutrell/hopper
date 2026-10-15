// Sandbox requests (issue #991, design.md "Sandboxes jobs start"): a running job asks the hopper for sandbox runs of the
// template its needs made (`sh "$HOPPER_SKILL" sandbox --needs …`). One user's requests, kept in memory, one per job and
// template: asked again, the job is told where its request is. A request waits for a person on Access requests unless
// the user's **skip sandbox approval** is on; then it is approved at once, by that toggle. Approved, the job runs its
// commands as box steps: each in a sandbox of its own, of the template, that the hopper burns after the step (issue
// #1349, src/sandbox/need-box.ts). The approval starts nothing: no box waits between steps, and none joins as a machine.
// Every step is an event on the job's timeline. A person declines a request with a reason the job is told. A request
// whose job is no longer at work is forgotten.
// Issue #1001: a run needs no separate approval when the user's auto-approve policy holds its template's blast radius,
// or when a person approved the template this job asked for, or waited on: that approval was given for this job's run;
// or when a person's remembered write approvals cover every change the template makes (src/domain/remembered-writes.ts).
// A request keeps the job's purpose, its plan and its link, for the person who decides.
import { randomUUID } from 'node:crypto';
import {
  AUTO_APPROVER, autoApproves, NO_PERSON, SKIP_SANDBOX_APPROVER, templateApprovalBy, type SandboxApprovals, type SandboxRequestView,
} from '../domain/sandbox-approvals.ts';
import { readApprovedWithoutPerson, REMEMBERED_APPROVER, rememberedCovers, type RememberedWrite } from '../domain/remembered-writes.ts';
import type { ReadPolicy } from '../domain/read-policy.ts';
import type { NewEvent } from '../domain/types.ts';
import type { TemplateView } from '../domain/vault.ts';

export interface SandboxRequestsOptions {
  record(event: NewEvent): void;
  approvals(): SandboxApprovals;
  template(name: string): TemplateView | undefined;
  /** Whether the job is at work: a request of a job that is not is forgotten. */
  atWork(jobId: string): boolean;
  jobTitle?(jobId: string): string | undefined;
  /** The job's issue or pull request (issue #1001). */
  jobUrl?(jobId: string): string | undefined;
  /** A person's write approvals the hopper remembers now (issue #1001), ended ones left out; absent: none. */
  remembered?(): RememberedWrite[];
  /** The read policy: with the auto-approve policy, whether a read in a template remembered approvals cover needs a person. */
  policy?(): ReadPolicy | undefined;
  clock: { now(): Date };
  newId?: () => string;
}

export type SandboxRequestResult = { ok: true } | { ok: false; code: 'not_found' | 'conflict'; error: string };

export interface SandboxRequests {
  /**
   * The job's request for a box of the template: the one it has, else a new one (approved at once when the toggle says
   * so). `about` (issue #1001): why the job asks and its plan, kept on a new request.
   */
  ask(jobId: string, template: string, about?: { purpose: string; plan?: string }): SandboxRequestView;
  /** The job waited on the template for a person's approval (issue #1001): that approval covers the job's run. */
  waited(jobId: string, template: string): void;
  /** A person approves a waiting request: the job's box steps run. */
  approve(id: string, by: string): SandboxRequestResult;
  /** A person declines a waiting request, with the reason the job is told. */
  decline(id: string, reason: string, by: string): SandboxRequestResult;
  /** The requests of jobs at work, oldest first. */
  list(): SandboxRequestView[];
}

export function createSandboxRequests(o: SandboxRequestsOptions): SandboxRequests {
  const newId = o.newId ?? (() => randomUUID());
  const requests = new Map<string, SandboxRequestView>();
  /** `<job> <template>`: the templates each job at work waited on for a person (issue #1001). */
  const waitedOn = new Set<string>();
  const event = (r: SandboxRequestView, type: NewEvent['type'], data: Record<string, unknown> = {}): void => {
    o.record({ type, jobId: r.jobId, data: { request: r.id, template: r.template, ...data } });
  };

  const forget = (): void => {
    for (const [id, r] of requests) if (!o.atWork(r.jobId)) requests.delete(id);
    for (const k of waitedOn) if (!o.atWork(k.slice(0, k.indexOf(' ')))) waitedOn.delete(k);
  };

  /**
   * Who approves the job's run with no second person, or undefined: skip sandbox approval; the auto-approve policy, for
   * the template's radius; a person's remembered write approvals that cover the template (issue #1001); a person's
   * approval of the template the job asked for or waited on.
   */
  const approverOf = (jobId: string, template: string): { by: string; radius?: string } | undefined => {
    if (o.approvals().skipSandboxApproval) return { by: SKIP_SANDBOX_APPROVER };
    const t = o.template(template);
    if (!t) return undefined;
    if (autoApproves(o.approvals(), t.radius?.level)) return { by: AUTO_APPROVER, radius: t.radius.level };
    if (o.remembered && rememberedCovers({ secrets: t.secrets ?? [], profiles: t.profiles ?? [] }, o.remembered(), readApprovedWithoutPerson(o.policy?.(), o.approvals()))) return { by: REMEMBERED_APPROVER };
    const person = t.approval?.by;
    const forJob = t.askedBy === jobId || waitedOn.has(`${jobId} ${template}`);
    return person && !NO_PERSON.includes(person) && forJob ? { by: templateApprovalBy(person) } : undefined;
  };

  const approve = (r: SandboxRequestView, by: string, data: Record<string, unknown> = {}): void => {
    r.state = 'approved';
    r.approvedBy = by;
    event(r, 'vault.sandbox_approved', { by, ...data });
  };

  const waiting = (id: string): SandboxRequestView | SandboxRequestResult => {
    const r = requests.get(id);
    if (!r) return { ok: false, code: 'not_found', error: `no sandbox request ${id}` };
    if (r.state !== 'waiting') return { ok: false, code: 'conflict', error: `sandbox request ${id} is ${r.state}, not waiting` };
    return r;
  };

  return {
    ask(jobId, template, about) {
      forget();
      const had = [...requests.values()].find((r) => r.jobId === jobId && r.template === template);
      if (had) return { ...had };
      const title = o.jobTitle?.(jobId), url = o.jobUrl?.(jobId);
      const r: SandboxRequestView = {
        id: newId(), jobId, ...(title ? { jobTitle: title } : {}), ...(url ? { jobUrl: url } : {}), template, state: 'waiting', askedAt: o.clock.now().toISOString(),
        ...(about ? { purpose: about.purpose, ...(about.plan ? { plan: about.plan } : {}) } : {}),
      };
      requests.set(r.id, r);
      event(r, 'vault.sandbox_requested');
      const approver = approverOf(jobId, template);
      if (approver) approve(r, approver.by, approver.radius ? { radius: approver.radius } : {});
      return { ...r };
    },
    waited(jobId, template) {
      waitedOn.add(`${jobId} ${template}`);
    },
    approve(id, by) {
      const r = waiting(id);
      if ('ok' in r) return r;
      approve(r, by);
      return { ok: true };
    },
    decline(id, reason, by) {
      const r = waiting(id);
      if ('ok' in r) return r;
      r.state = 'declined';
      r.reason = reason;
      event(r, 'vault.sandbox_declined', { reason, by });
      return { ok: true };
    },
    list() {
      forget();
      return [...requests.values()].map((r) => ({ ...r }));
    },
  };
}

