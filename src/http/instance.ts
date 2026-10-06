// GET /api/instance (issues #221 and #241, design.md "What an admin sees"): the totals across every user —
// users, jobs not ended by status, open questions, lanes, jobs ended in the last day, usage readings summed
// per unit and usage window — never one user's share and nothing named. An instance read: an admin session,
// or loopback without one (as GET /api/users).
import type { FastifyInstance } from 'fastify';
import type { Clock } from '../domain/ports.ts';
import { ENDED_STATUSES, IN_FLIGHT_STATUSES, roleAllows, type InstanceTotals, type UsageReading, type UsageTotal } from '../domain/types.ts';
import { HttpError } from './errors.ts';
import { roleOfRequest, type Tenants } from './tenants.ts';

const DAY_MS = 86_400_000;

/** Readings summed per unit and usage window, in the order each pair first appears. */
export function usageTotals(readings: readonly UsageReading[]): UsageTotal[] {
  const totals = new Map<string, UsageTotal>();
  for (const r of readings) {
    const key = JSON.stringify([r.unit, r.window ?? null]);
    const t = totals.get(key) ?? { unit: r.unit, ...(r.window !== undefined ? { window: r.window } : {}), used: 0, limit: 0, readings: 0 };
    t.used += r.used;
    t.limit += r.limit;
    t.readings++;
    totals.set(key, t);
  }
  return [...totals.values()];
}

export async function instanceTotals(tenants: Pick<Tenants, 'list' | 'user'>, now: Date): Promise<InstanceTotals> {
  const users = tenants.list();
  const since = now.getTime() - DAY_MS;
  const totals: InstanceTotals = {
    users: users.length,
    jobs: Object.fromEntries(IN_FLIGHT_STATUSES.map((s) => [s, 0])) as InstanceTotals['jobs'],
    questions: { open: 0 },
    lanes: { busy: 0, total: 0 },
    endedLastDay: Object.fromEntries(ENDED_STATUSES.map((s) => [s, 0])) as InstanceTotals['endedLastDay'],
    usage: [],
  };
  const readings: UsageReading[] = [];
  for (const u of users) {
    const parts = tenants.user(u.id);
    if (!parts) continue;
    const { store } = parts;
    for (const j of store.jobs.list({ status: [...IN_FLIGHT_STATUSES] })) totals.jobs[j.status as keyof InstanceTotals['jobs']]++;
    for (const j of store.jobs.list({ status: [...ENDED_STATUSES] })) {
      if (j.finishedAt !== undefined && Date.parse(j.finishedAt) >= since) totals.endedLastDay[j.status as keyof InstanceTotals['endedLastDay']]++;
    }
    totals.questions.open += store.questions.list({ status: ['open'] }).length;
    const lanes = store.lanes.list();
    totals.lanes.total += lanes.length;
    totals.lanes.busy += lanes.filter((l) => l.jobId !== undefined).length;
    readings.push(...(await parts.engine.getUsageReport()).readings);
  }
  totals.usage = usageTotals(readings);
  return totals;
}

export function instanceRoutes(app: FastifyInstance, o: { tenants: Pick<Tenants, 'list' | 'user'>; clock: Clock }): void {
  app.get('/api/instance', async (req): Promise<InstanceTotals> => {
    const role = roleOfRequest(req);
    if (role && !roleAllows(role, 'admin')) throw new HttpError(403, `role ${role} may not read the instance totals; it needs admin`);
    return instanceTotals(o.tenants, o.clock.now());
  });
}
