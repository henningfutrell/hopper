// Sandbox requests (issue #991, design.md "Sandboxes jobs start"): a running job asks the hopper for a box of the
// template its needs made (`sh "$HOPPER_SKILL" sandbox --needs …`), and the hopper starts it. One user's requests, kept
// in memory, one per job and template: asked again, the job is told where its request is, and gets the box it started.
// A request waits for a person on Access requests unless the user's **skip sandbox approval** is on; then it is approved
// at once, by that toggle. Approved, the hopper starts the box through the sandbox module with the template's defaults,
// and the box joins as a machine. Every step is an event on the job's timeline. A person declines a request with a
// reason the job is told; a start that failed stays failed. A request whose job is no longer at work is forgotten;
// its box ends at its time limit. A start never runs in the request that approves it (issue #1002): the approval is
// recorded and answered, and the box starts after, in the background, with a time limit of its own. A start that has
// not ended in that time fails with that reason; whatever it does after is not the request's any more.
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
  /** Starts a box of the template, with its defaults; throws when it did not start. */
  launch(template: TemplateView): Promise<{ container: string }>;
  /** Whether the user's box of that name is still there. */
  alive(container: string): boolean;
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
  /** How long a start may take before its request fails (issue #1002); default START_MS. */
  startMs?: number;
}

/** How long a box's start may take, its image pull and build included, before its request fails (issue #1002). */
export const START_MS = 20 * 60_000;

export type SandboxRequestResult = { ok: true } | { ok: false; code: 'not_found' | 'conflict'; error: string };

export interface SandboxRequests {
  /**
   * The job's request for a box of the template: the one it has, else a new one (approved at once when the toggle says
   * so). `about` (issue #1001): why the job asks and its plan, kept on a new request.
   */
  ask(jobId: string, template: string, about?: { purpose: string; plan?: string }): SandboxRequestView;
  /** The job waited on the template for a person's approval (issue #1001): that approval covers the job's run. */
  waited(jobId: string, template: string): void;
  /** A person approves a waiting request: the box starts. */
  approve(id: string, by: string): SandboxRequestResult;
  /** A person declines a waiting request, with the reason the job is told. */
  decline(id: string, reason: string, by: string): SandboxRequestResult;
  /** The requests of jobs at work, oldest first. */
  list(): SandboxRequestView[];
  /** Resolves when no box of a request is starting. */
  idle(): Promise<void>;
}

export function createSandboxRequests(o: SandboxRequestsOptions): SandboxRequests {
  const newId = o.newId ?? (() => randomUUID());
  const requests = new Map<string, SandboxRequestView>();
  const starting = new Set<Promise<void>>();
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

  const start = (r: SandboxRequestView, by: string, data: Record<string, unknown> = {}): void => {
    r.state = 'starting';
    r.approvedBy = by;
    event(r, 'vault.sandbox_approved', { by, ...data });
    let ended = false;
    const end = (then: () => void): void => {
      if (ended) return;
      ended = true;
      then();
    };
    const fail = (reason: string): void => end(() => {
      r.state = 'failed';
      r.reason = reason;
      event(r, 'vault.sandbox_failed', { reason });
    });
    const limit = o.startMs ?? START_MS;
    // After the approval's answer, never in it (issue #1002): nothing of the start runs in the request that approves it.
    const p = new Promise<void>((resolve) => {
      setImmediate(() => {
        const timer = setTimeout(() => { fail(`the box did not start in ${minutes(limit)}`); resolve(); }, limit);
        timer.unref();
        const t = o.template(r.template);
        const launched = t ? o.launch(t) : Promise.reject(new Error(`template ${r.template} is not there any more`));
        launched.then(({ container }) => end(() => {
          r.state = 'running';
          r.container = container;
          event(r, 'vault.sandbox_started', { container });
        }), (e: unknown) => fail(e instanceof Error ? e.message : String(e))).finally(() => { clearTimeout(timer); resolve(); });
      });
    });
    starting.add(p);
    void p.finally(() => starting.delete(p));
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
      // A box that went: the job's next ask is a new request. A start that failed stays failed: asked again on each
      // event, a new one would start the box again and again.
      const ended = had && had.state === 'running' && !o.alive(had.container!);
      if (had && !ended) return { ...had };
      if (had) requests.delete(had.id);
      const title = o.jobTitle?.(jobId), url = o.jobUrl?.(jobId);
      const r: SandboxRequestView = {
        id: newId(), jobId, ...(title ? { jobTitle: title } : {}), ...(url ? { jobUrl: url } : {}), template, state: 'waiting', askedAt: o.clock.now().toISOString(),
        ...(about ? { purpose: about.purpose, ...(about.plan ? { plan: about.plan } : {}) } : {}),
      };
      requests.set(r.id, r);
      event(r, 'vault.sandbox_requested');
      const approver = approverOf(jobId, template);
      if (approver) start(r, approver.by, approver.radius ? { radius: approver.radius } : {});
      return { ...r };
    },
    waited(jobId, template) {
      waitedOn.add(`${jobId} ${template}`);
    },
    approve(id, by) {
      const r = waiting(id);
      if ('ok' in r) return r;
      start(r, by);
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
    async idle() {
      while (starting.size > 0) await Promise.allSettled([...starting]);
    },
  };
}

const minutes = (ms: number): string => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);
