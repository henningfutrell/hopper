// Sandbox requests (issue #991, design.md "Sandboxes jobs start"): a running job asks the hopper for a box of the
// template its needs made (`sh "$HOPPER_SKILL" sandbox --needs …`), and the hopper starts it. One user's requests, kept
// in memory, one per job and template: asked again, the job is told where its request is, and gets the box it started.
// A request waits for a person on Access requests unless the user's **skip sandbox approval** is on; then it is approved
// at once, by that toggle. Approved, the hopper starts the box through the sandbox module with the template's defaults,
// and the box joins as a machine. Every step is an event on the job's timeline. A person declines a request with a
// reason the job is told. A request whose job is no longer at work is forgotten; its box ends at its time limit.
import { randomUUID } from 'node:crypto';
import { SKIP_SANDBOX_APPROVER, type SandboxApprovals, type SandboxRequestView } from '../domain/sandbox-approvals.ts';
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
  clock: { now(): Date };
  newId?: () => string;
}

export type SandboxRequestResult = { ok: true } | { ok: false; code: 'not_found' | 'conflict'; error: string };

export interface SandboxRequests {
  /** The job's request for a box of the template: the one it has, else a new one (approved at once when the toggle says so). */
  ask(jobId: string, template: string): SandboxRequestView;
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
  const event = (r: SandboxRequestView, type: NewEvent['type'], data: Record<string, unknown> = {}): void => {
    o.record({ type, jobId: r.jobId, data: { request: r.id, template: r.template, ...data } });
  };

  const forget = (): void => {
    for (const [id, r] of requests) if (!o.atWork(r.jobId)) requests.delete(id);
  };

  const start = (r: SandboxRequestView, by: string): void => {
    r.state = 'starting';
    r.approvedBy = by;
    event(r, 'vault.sandbox_approved', { by });
    const fail = (reason: string): void => {
      r.state = 'failed';
      r.reason = reason;
      event(r, 'vault.sandbox_failed', { reason });
    };
    const t = o.template(r.template);
    if (!t) return fail(`template ${r.template} is not there any more`);
    const p = o.launch(t).then(({ container }) => {
      r.state = 'running';
      r.container = container;
      event(r, 'vault.sandbox_started', { container });
    }, (e: unknown) => fail(e instanceof Error ? e.message : String(e)));
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
    ask(jobId, template) {
      forget();
      const had = [...requests.values()].find((r) => r.jobId === jobId && r.template === template);
      // A box that went, or a start that failed: the job's next ask is a new request.
      const ended = had && (had.state === 'failed' || (had.state === 'running' && !o.alive(had.container!)));
      if (had && !ended) return { ...had };
      if (had) requests.delete(had.id);
      const title = o.jobTitle?.(jobId);
      const r: SandboxRequestView = { id: newId(), jobId, ...(title ? { jobTitle: title } : {}), template, state: 'waiting', askedAt: o.clock.now().toISOString() };
      requests.set(r.id, r);
      event(r, 'vault.sandbox_requested');
      if (o.approvals().skipSandboxApproval) start(r, SKIP_SANDBOX_APPROVER);
      return { ...r };
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
