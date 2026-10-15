// One user's sandbox requests (issue #991, design.md "Sandboxes jobs start"), built from their store and vault: each
// request approved by a person, or by the user's skip sandbox approval, the auto-approve policy or a remembered write
// approval (issue #1001). Approved, the job's box steps run, each in a sandbox of its own (issue #1349).
import { liveWrites, rememberHoursOf } from '../domain/remembered-writes.ts';
import { NO_SKIPS } from '../domain/sandbox-approvals.ts';
import type { UserStore } from '../domain/ports.ts';
import type { TemplateView } from '../domain/vault.ts';
import { createSandboxRequests, type SandboxRequests } from '../sandbox/requests.ts';
import type { Sandboxes } from '../sandbox/service.ts';

/** Runs a job's need step or box step (issues #1007, #1349) in a sandbox of its own, burned after it. */
export interface SandboxLauncher {
  needStep: Sandboxes['needStep'];
}

const AT_WORK = ['running', 'waiting_answer', 'waiting_on'];

export function userSandboxRequests(o: {
  userId: string; store: Pick<UserStore, 'events' | 'settings' | 'jobs'>; templates: () => TemplateView[]; clock: { now(): Date };
}): SandboxRequests {
  const { store } = o;
  return createSandboxRequests({
    record: (e) => { store.events.append(e); },
    approvals: () => store.settings.getSandboxApprovals() ?? NO_SKIPS,
    template: (name) => o.templates().find((t) => t.name === name),
    atWork: (id) => AT_WORK.includes(store.jobs.get(id)?.status ?? ''),
    jobTitle: (id) => { const j = store.jobs.get(id); return j?.source?.title ?? j?.spec.goal; },
    jobUrl: (id) => store.jobs.get(id)?.source?.url,
    // Issue #1001: a person's remembered write approvals, and the read policy for the reads beside them.
    remembered: () => liveWrites(store.settings.getRememberedWrites(), rememberHoursOf(store.settings.getSandboxApprovals()), o.clock.now()),
    policy: () => store.settings.getReadPolicy(),
    clock: o.clock,
  });
}

