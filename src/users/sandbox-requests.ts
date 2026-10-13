// One user's sandbox requests (issue #991, design.md "Sandboxes jobs start"), built from their store and vault: each
// request approved by a person, or by the user's skip sandbox approval, the auto-approve policy or a remembered write
// approval (issue #1001); the box started through the sandbox module.
import { liveWrites, rememberHoursOf } from '../domain/remembered-writes.ts';
import { NO_SKIPS } from '../domain/sandbox-approvals.ts';
import type { UserStore } from '../domain/ports.ts';
import type { TemplateView } from '../domain/vault.ts';
import type { StepResult } from '../domain/windows-steps.ts';
import type { BoxStepCall } from '../sandbox/box-step.ts';
import { createSandboxRequests, type SandboxRequests } from '../sandbox/requests.ts';
import type { StepBoxes } from '../windows-steps/service.ts';
import type { Sandboxes } from '../sandbox/service.ts';

/**
 * Starts a box of a template for a job's sandbox request, says whether a box of the user's is still there, and runs a
 * job's box step in it (issue #1004).
 */
export interface SandboxLauncher {
  launch(userId: string, template: TemplateView): Promise<{ container: string }>;
  alive(userId: string, container: string): boolean;
  step(userId: string, container: string, step: BoxStepCall, io: { log(chunk: string): void; signal: AbortSignal }): Promise<StepResult>;
  /** Runs one need step of the user's (issue #1007) in a one-shot need box. Absent: no need step runs. */
  needStep?: Sandboxes['needStep'];
  /** How long a start may take before its request fails (issue #1002); default START_MS. */
  startMs?: number;
}

const AT_WORK = ['running', 'waiting_answer', 'waiting_on'];

export function userSandboxRequests(o: {
  userId: string; store: Pick<UserStore, 'events' | 'settings' | 'jobs'>; templates: () => TemplateView[]; sandboxes: SandboxLauncher | undefined; clock: { now(): Date };
}): SandboxRequests {
  const { store } = o;
  return createSandboxRequests({
    record: (e) => { store.events.append(e); },
    approvals: () => store.settings.getSandboxApprovals() ?? NO_SKIPS,
    template: (name) => o.templates().find((t) => t.name === name),
    launch: (t) => (o.sandboxes ? o.sandboxes.launch(o.userId, t) : Promise.reject(new Error('this hopper starts no sandbox box'))),
    alive: (c) => o.sandboxes?.alive(o.userId, c) ?? false,
    atWork: (id) => AT_WORK.includes(store.jobs.get(id)?.status ?? ''),
    jobTitle: (id) => { const j = store.jobs.get(id); return j?.source?.title ?? j?.spec.goal; },
    jobUrl: (id) => store.jobs.get(id)?.source?.url,
    // Issue #1001: a person's remembered write approvals, and the read policy for the reads beside them.
    remembered: () => liveWrites(store.settings.getRememberedWrites(), rememberHoursOf(store.settings.getSandboxApprovals()), o.clock.now()),
    policy: () => store.settings.getReadPolicy(),
    clock: o.clock,
    ...(o.sandboxes?.startMs !== undefined ? { startMs: o.sandboxes.startMs } : {}),
  });
}

/**
 * The boxes a job's steps run in (issue #1004, design.md "Box steps"): the boxes the job's own sandbox requests started,
 * that are still there. A step runs in one through the sandbox module, with the job's proxy token and the box's vault
 * helper, as its client named it.
 */
export function stepBoxes(o: {
  userId: string; requests: SandboxRequests; sandboxes: SandboxLauncher; token(jobId: string): string; helper(box: string): Promise<string | undefined>;
}): StepBoxes {
  return {
    of: (job) => o.requests.list()
      .filter((r) => r.jobId === job.id && r.state === 'running' && r.container !== undefined && o.sandboxes.alive(o.userId, r.container))
      .map((r) => ({ name: r.container!, template: r.template })),
    run: async (job, box, step, io) => {
      const helper = await o.helper(box);
      return o.sandboxes.step(o.userId, box, { ...step, token: o.token(job.id), ...(helper ? { helper } : {}) }, io);
    },
  };
}
