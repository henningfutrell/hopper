// GET /api/sections (issue #543, design.md "Sections"): every section type in nav order, with what is open in it, how
// many of those wait on a person, and how many of those are high priority (#535), and the event types it emits. A
// section's open rule is its own, and stays where the section is: an open question at the human tier, a parked job's
// too (issue #2634: it still blocks its job); a pending login; an open problem or hand-off, or work not pushed (issue #1010); a review item open or being revised, its job not
// parked on it (issue #2167), waiting on a person at the human stage; a parked job, waiting on a person to pick it up (issue #565).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { UserStore } from '../domain/ports.ts';
import { keptWorkLeft } from '../failures/kept-work.ts';
import { jobPriorityTag, parkedItemOf, REVIEW_OPEN_STATUSES, SECTION_KINDS, SECTIONS, TERMINAL_STATUSES, type JobId, type SectionKind, type SectionSummary } from '../domain/types.ts';
import type { TenantParts } from './tenants.ts';

type Counts = Omit<SectionSummary, 'kind' | 'label' | 'events'>;

function count(store: UserStore, kind: SectionKind): Counts {
  const lanes = store.settings.getPriorityLanes();
  const high = (jobIds: readonly (JobId | undefined)[]) => jobIds.filter((id) => jobPriorityTag(store.jobs, lanes, id)?.high === true).length;
  const review = SECTIONS[kind].review;
  if (review) {
    // An item its job is parked on is in Parked, with its job (issue #2167).
    const open = store.reviews[review].list({ status: [...REVIEW_OPEN_STATUSES] }).filter((p) => !parkedItemOf(store.jobs.get(p.jobId), p));
    const waiting = open.filter((p) => p.status === 'open' && p.stage === 'human');
    return { open: open.length, waiting: waiting.length, high: high(waiting.map((p) => p.jobId)) };
  }
  if (kind === 'questions') {
    // A parked job's question counts too (issue #2634): it still blocks its job, and most waits park by themselves.
    const open = store.questions.list({ status: ['open'] });
    const waiting = open.filter((q) => q.tier === 'human');
    return { open: open.length, waiting: waiting.length, high: high(waiting.map((q) => q.jobId)) };
  }
  if (kind === 'parked') {
    const parked = store.jobs.list({ status: ['parked'] });
    return { open: parked.length, waiting: parked.length, high: high(parked.map((j) => j.id)) };
  }
  if (kind === 'logins') {
    const open = store.logins.list({ status: ['pending'] });
    return { open: open.length, waiting: open.length, high: high(open.map((l) => l.jobId)) };
  }
  const problems = store.problems.list({ status: 'open' });
  const handoffs = store.handoffs.list({ status: 'open' });
  // Work not pushed (issue #1010): an ended job's kept work waits on a person too, as the work-item ledger has it (issue
  // #1067), unless its hand-off counts it already.
  const kept = keptWorkLeft(store)
    .filter((k) => { const job = store.jobs.get(k.jobId); return job !== undefined && TERMINAL_STATUSES.includes(job.status) && store.handoffs.forJob(k.jobId)?.status !== 'open'; });
  const n = problems.length + handoffs.length + kept.length;
  return { open: n, waiting: n, high: high([...handoffs.map((h) => h.jobId), ...kept.map((k) => k.jobId)]) };
}

export function sectionRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/sections', async (req) => {
    const { store } = o.tenant(req);
    const sections: SectionSummary[] = SECTION_KINDS.map((kind) => ({ kind, label: SECTIONS[kind].label, ...count(store, kind), events: [...SECTIONS[kind].events] }));
    return { sections };
  });
}
