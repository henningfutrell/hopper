// GET /api/instance (issue #221, design.md "What an admin sees"): the totals across every user — users,
// jobs not ended by status, open questions, lanes — never one user's share and nothing named. An
// instance read: an admin session, or loopback without one (as GET /api/users).
import type { FastifyInstance } from 'fastify';
import { IN_FLIGHT_STATUSES, roleAllows, type InstanceTotals } from '../domain/types.ts';
import { HttpError } from './errors.ts';
import { sessionToken } from './host-guard.ts';
import type { Tenants } from './tenants.ts';
import type { UiSessions } from './ui/sessions.ts';

export function instanceTotals(tenants: Pick<Tenants, 'list' | 'user'>): InstanceTotals {
  const users = tenants.list();
  const totals: InstanceTotals = {
    users: users.length,
    jobs: Object.fromEntries(IN_FLIGHT_STATUSES.map((s) => [s, 0])) as InstanceTotals['jobs'],
    questions: { open: 0 },
    lanes: { busy: 0, total: 0 },
  };
  for (const u of users) {
    const store = tenants.user(u.id)?.store;
    if (!store) continue;
    for (const j of store.jobs.list({ status: [...IN_FLIGHT_STATUSES] })) totals.jobs[j.status as keyof InstanceTotals['jobs']]++;
    totals.questions.open += store.questions.list({ status: ['open'] }).length;
    const lanes = store.lanes.list();
    totals.lanes.total += lanes.length;
    totals.lanes.busy += lanes.filter((l) => l.jobId !== undefined).length;
  }
  return totals;
}

export function instanceRoutes(app: FastifyInstance, o: { tenants: Pick<Tenants, 'list' | 'user'>; sessions: UiSessions }): void {
  app.get('/api/instance', async (req): Promise<InstanceTotals> => {
    const s = o.sessions.find(sessionToken(req));
    if (s && !roleAllows(s.role, 'admin')) throw new HttpError(403, `role ${s.role} may not read the instance totals; it needs admin`);
    return instanceTotals(o.tenants);
  });
}
