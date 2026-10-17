// One user's sandbox requests (issue #991, design.md "Sandboxes jobs start"), built from their store and vault: each
// request approved by a person, or by the user's skip sandbox approval, the auto-approve policy or a remembered write
// approval (issue #1001). Approved, the job's box steps run, each in a sandbox of its own (issue #1349). Issue #1471: a
// job's requests are kept from before it starts — the sandboxes its prompt names are asked for then — until it ends.
import { liveWrites, rememberHoursOf } from '../domain/remembered-writes.ts';
import { NO_SKIPS } from '../domain/sandbox-approvals.ts';
import type { UserStore } from '../domain/ports.ts';
import type { TemplateView } from '../domain/vault.ts';
import type { Job } from '../domain/types.ts';
import { namedTemplates, sandboxesHold } from '../domain/sandboxes-before-start.ts';
import { createSandboxRequests, type SandboxRequests } from '../sandbox/requests.ts';
import type { Sandboxes } from '../sandbox/service.ts';

/** Runs a job's need step or box step (issues #1007, #1349) in a sandbox of its own, burned after it. */
export interface SandboxLauncher {
  needStep: Sandboxes['needStep'];
}

/** A job not ended: waiting to start (issue #1471), starting, or at work. */
const LIVE = ['queued', 'held', 'claimed', 'running', 'waiting_answer', 'waiting_on'];

/** Why the hopper asked for a sandbox before the job started (issue #1471), for the person who approves it. */
export const BEFORE_START_PURPOSE = 'The job\'s brief names this template. The hopper asks for its sandbox runs before the job starts, so the job does not stop mid-run.';

/**
 * Issue #1471, design.md "Sandboxes before the start": for each waiting job not yet started — accepted, of a judged origin
 * and text, not resuming —, ask for the sandbox runs of every template of the user its prompt names, then answer the
 * jobs those requests hold, with why. Asked again, a request is the one the job has: nothing is asked twice.
 */
export function sandboxesHeld(requests: SandboxRequests, templates: () => readonly TemplateView[], waiting: readonly Job[]): { jobId: string; reason: string }[] {
  const toStart = waiting.filter((job) => job.accepted !== false && !job.originPending && !job.textChange && job.pendingAnswer === undefined && typeof job.spec.payload.prompt === 'string');
  if (toStart.length === 0) return [];
  // Read only when a job may name one: the vault's view is not free, and this runs at each Decision.
  const all = templates(), names = all.map((t) => t.name);
  return toStart.flatMap((job) => {
    const named = namedTemplates(job.spec.payload.prompt as string, names);
    if (named.length === 0) return [];
    const reason = sandboxesHold(named.map((t) => requests.ask(job.id, t, { purpose: BEFORE_START_PURPOSE })), all);
    return reason ? [{ jobId: job.id, reason }] : [];
  });
}

export function userSandboxRequests(o: {
  userId: string; store: Pick<UserStore, 'events' | 'settings' | 'jobs'>; templates: () => TemplateView[]; clock: { now(): Date };
}): SandboxRequests {
  const { store } = o;
  return createSandboxRequests({
    record: (e) => { store.events.append(e); },
    approvals: () => store.settings.getSandboxApprovals() ?? NO_SKIPS,
    template: (name) => o.templates().find((t) => t.name === name),
    live: (id) => LIVE.includes(store.jobs.get(id)?.status ?? ''),
    jobTitle: (id) => { const j = store.jobs.get(id); return j?.source?.title ?? j?.spec.goal; },
    jobUrl: (id) => store.jobs.get(id)?.source?.url,
    // Issue #1001: a person's remembered write approvals, and the read policy for the reads beside them.
    remembered: () => liveWrites(store.settings.getRememberedWrites(), rememberHoursOf(store.settings.getSandboxApprovals()), o.clock.now()),
    policy: () => store.settings.getReadPolicy(),
    clock: o.clock,
  });
}

