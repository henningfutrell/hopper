// GET /api/sections (issue #543, design.md "Sections"): every section type in nav order, with what is open in it, how
// many of those wait on a person, and how many of those are high priority (#535), and the event types it emits. A
// section's open rule is its own, and stays where the section is: an open question at the human tier; a pending login;
// an open problem or hand-off; a review item open or being revised, waiting on a person at the human stage.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { UserStore } from '../domain/ports.ts';
import { jobPriorityTag, REVIEW_OPEN_STATUSES, SECTION_KINDS, SECTIONS, type JobId, type SectionKind, type SectionSummary } from '../domain/types.ts';
import type { TenantParts } from './tenants.ts';

type Counts = Omit<SectionSummary, 'kind' | 'label' | 'events'>;

function count(store: UserStore, kind: SectionKind): Counts {
  const lanes = store.settings.getPriorityLanes();
  const high = (jobIds: readonly (JobId | undefined)[]) => jobIds.filter((id) => jobPriorityTag(store.jobs, lanes, id)?.high === true).length;
  const review = SECTIONS[kind].review;
  if (review) {
    const open = store.reviews[review].list({ status: [...REVIEW_OPEN_STATUSES] });
    const waiting = open.filter((p) => p.status === 'open' && p.stage === 'human');
    return { open: open.length, waiting: waiting.length, high: high(waiting.map((p) => p.jobId)) };
  }
  if (kind === 'questions') {
    const open = store.questions.list({ status: ['open'] });
    const waiting = open.filter((q) => q.tier === 'human');
    return { open: open.length, waiting: waiting.length, high: high(waiting.map((q) => q.jobId)) };
  }
  if (kind === 'logins') {
    const open = store.logins.list({ status: ['pending'] });
    return { open: open.length, waiting: open.length, high: high(open.map((l) => l.jobId)) };
  }
  const problems = store.problems.list({ status: 'open' });
  const handoffs = store.handoffs.list({ status: 'open' });
  return { open: problems.length + handoffs.length, waiting: problems.length + handoffs.length, high: high(handoffs.map((h) => h.jobId)) };
}

export function sectionRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/sections', async (req) => {
    const { store } = o.tenant(req);
    const sections: SectionSummary[] = SECTION_KINDS.map((kind) => ({ kind, label: SECTIONS[kind].label, ...count(store, kind), events: [...SECTIONS[kind].events] }));
    return { sections };
  });
}
