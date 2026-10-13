// One user's sandbox requests (issue #991, design.md "Sandboxes jobs start"), built from their store and vault: each
// request approved by a person, or by the user's skip sandbox approval; the box started through the sandbox module.
import { NO_SKIPS } from '../domain/sandbox-approvals.ts';
import type { UserStore } from '../domain/ports.ts';
import type { TemplateView } from '../domain/vault.ts';
import { createSandboxRequests, type SandboxRequests } from '../sandbox/requests.ts';

/** Starts a box of a template for a job's sandbox request, and says whether a box of the user's is still there. */
export interface SandboxLauncher {
  launch(userId: string, template: TemplateView): Promise<{ container: string }>;
  alive(userId: string, container: string): boolean;
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
    clock: o.clock,
  });
}
