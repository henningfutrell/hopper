// Run cards (issue #2197, design.md "One approval per sandbox run"): one card per job and template that waits for a
// person — the template's approval (its image, tools, egress, secrets or profiles), the job's sandbox run, or both. A
// person approves or declines the card once: the template as it is, each profile it lists, and the run, in one action.
// A person never approves a template a job asked for on a card of its own: the template is the hopper's cache of the
// access. Issue #2206: a job's asks for an AWS action on a role the card's template changes are on its card, and the one
// approval grants them too. Pure.
import type { ActionAskView } from './action-grants.ts';
import type { OperationProfile } from './types.ts';
import type { SandboxRequestView } from './sandbox-approvals.ts';
import { approvalCovers, type TemplateView } from './vault.ts';

/** A job's ask that waited on a template for a person (issue #2197): kept in memory while the job lives. */
export interface TemplateWait {
  jobId: string;
  template: string;
  purpose?: string;
  plan?: string;
  askedAt: string;
}

/** One job's ask that waits for a person: the job, why it asks, its plan, and what waits. */
export interface RunCardView {
  jobId: string;
  jobTitle?: string;
  jobUrl?: string;
  template: string;
  /** Why the job asks, in its own words. */
  purpose?: string;
  /** What the step will do: the commands or the plan, and for each change what it changes and whether it can be undone. */
  plan?: string;
  askedAt: string;
  /** What waits for the person: the template's approval, the run's, or both. */
  waits: { template: boolean; run: boolean };
  /** The job's sandbox request that waits, when one does. */
  request?: string;
  /** Jev's check of the request (issue #655 part 13), as the request has it. */
  jev?: SandboxRequestView['jev'];
  /** The job's asks for an AWS action on a role the template changes (issue #2206): the card's approval grants them. */
  actions?: ActionAskView[];
}

/** The job as a card names it; undefined: the job ended, or the hopper does not know it. */
export type CardJob = (jobId: string) => { title?: string; url?: string } | undefined;

/**
 * A template waits for a person: never approved, or a new image, tool, egress host, secret or profile waits. For a
 * job's run (`jobId`, part 3), also when its approval is for other jobs only.
 */
export const waitsForPerson = (t: TemplateView, jobId?: string): boolean =>
  !t.approval || (jobId !== undefined && !approvalCovers(t, jobId)) || t.pending.image || t.pending.egress.length > 0 || (t.pending.bastionTargets?.length ?? 0) > 0 || t.pending.secrets.length > 0 || t.pending.profiles.length > 0;

const HIGH = ['write', 'sync', 'apply', 'observe'];

/**
 * What approves all a card lists (issue #1001's Approve all listed): the template as it is — its image, tools, egress,
 * secrets and read profiles — when any of that waits, or (part 3) its approval does not cover the job's run, then each
 * write, sync or apply profile, which takes its own approval.
 */
export function approvalsOf(t: TemplateView, jobId?: string): { whole: boolean; profiles: OperationProfile[] } {
  const profiles = t.pending.profiles.filter((p) => HIGH.includes(p.operation));
  const reads = t.pending.profiles.length - profiles.length;
  return { whole: !t.approval || (jobId !== undefined && !approvalCovers(t, jobId)) || t.pending.image || t.pending.egress.length > 0 || (t.pending.bastionTargets?.length ?? 0) > 0 || t.pending.secrets.length > 0 || reads > 0, profiles };
}

/**
 * The run cards, oldest first: each waiting sandbox request of a live job; each ask of a live job that waits on a
 * template for a person; and each waiting template a live job asked for (`askedBy`), so a template that waited before a
 * restart, when the hopper kept no ask, is a card too. One card per job and template. A waiting template no live job
 * waits on is no card: nothing runs when it is approved. A job's run of the template a person declined is no card: the
 * job was told no.
 */
export function runCards(o: {
  templates: readonly TemplateView[]; requests: readonly SandboxRequestView[]; waits: readonly TemplateWait[]; job: CardJob; actionAsks?: readonly ActionAskView[];
}): RunCardView[] {
  const byName = new Map(o.templates.map((t) => [t.name, t]));
  const cards = new Map<string, RunCardView>();
  const declined = new Set(o.requests.filter((r) => r.state === 'declined').map((r) => `${r.jobId} ${r.template}`));
  const add = (c: Omit<RunCardView, 'jobTitle' | 'jobUrl' | 'actions'>): void => {
    const key = `${c.jobId} ${c.template}`;
    const job = o.job(c.jobId);
    if (cards.has(key) || declined.has(key) || !job) return;
    const t = byName.get(c.template);
    const actions = (o.actionAsks ?? []).filter((a) => a.job === c.jobId && t !== undefined && changesRole(t, a.role));
    cards.set(key, { ...c, ...(job.title ? { jobTitle: job.title } : {}), ...(job.url ? { jobUrl: job.url } : {}), ...(actions.length ? { actions } : {}) });
  };
  const about = (x: { purpose?: string; plan?: string }) => ({ ...(x.purpose ? { purpose: x.purpose } : {}), ...(x.plan ? { plan: x.plan } : {}) });
  const waiting = (name: string, jobId: string): boolean => { const t = byName.get(name); return t !== undefined && waitsForPerson(t, jobId); };
  for (const r of o.requests) {
    if (r.state !== 'waiting') continue;
    add({ jobId: r.jobId, template: r.template, ...about(r), askedAt: r.askedAt, waits: { template: waiting(r.template, r.jobId), run: true }, request: r.id, ...(r.jev ? { jev: r.jev } : {}) });
  }
  for (const w of o.waits) if (waiting(w.template, w.jobId)) add({ jobId: w.jobId, template: w.template, ...about(w), askedAt: w.askedAt, waits: { template: true, run: false } });
  for (const t of o.templates) if (t.askedBy && waitsForPerson(t, t.askedBy)) add({ jobId: t.askedBy, template: t.name, ...about(t), askedAt: t.savedAt, waits: { template: true, run: false } });
  return [...cards.values()].sort((a, b) => a.askedAt.localeCompare(b.askedAt));
}

/** Whether the template changes the aws-role `role` (`<account>/<role>`): a write, sync or apply profile of it. */
const changesRole = (t: TemplateView, role: string): boolean => t.profiles.some((p) => p.asset.kind === 'aws-role' && p.asset.name === role && p.operation !== 'read');

/** The asks for an AWS action no run card holds (issue #2206): each is an item of its own on Access requests. */
export const looseAsks = (asks: readonly ActionAskView[], runs: readonly RunCardView[]): ActionAskView[] =>
  asks.filter((a) => !runs.some((r) => r.actions?.includes(a)));

/** The waiting templates no run card holds: a person's own templates, approved on a template card as before. */
export const templateCards = (templates: readonly TemplateView[], runs: readonly RunCardView[]): TemplateView[] =>
  templates.filter((t) => waitsForPerson(t) && !t.askedBy && !runs.some((r) => r.template === t.name));
