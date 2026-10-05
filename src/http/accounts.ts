// GET /api/accounts: who each part acts as on an outside service (design.md "Usage and accounts
// (issue #18)"). Read-only, and facts only: each usage source's account (its state) and each job
// source's (`detail.account` in its status) — a part describes its own, so a custom plugin's appears
// the same way. Never a token: no part puts one there, and nothing else is read.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Account, PartAccount, SourceStatus, UsageSourceReport } from '../domain/types.ts';
import type { TenantParts } from './tenants.ts';

const isAccount = (v: unknown): v is Account =>
  typeof v === 'object' && v !== null && typeof (v as Account).service === 'string' && typeof (v as Account).detail === 'object';

export function accountsOf(usage: UsageSourceReport[], sources: SourceStatus[]): PartAccount[] {
  return [
    ...usage.flatMap((u) => (u.account ? [{ role: 'usage-source' as const, instance: u.name, ...u.account }] : [])),
    ...sources.flatMap((s) => (isAccount(s.detail.account) ? [{ role: 'job-source' as const, instance: s.name, ...s.detail.account }] : [])),
  ];
}

export function accountRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/accounts', async (req) => { const t = o.tenant(req); return { accounts: accountsOf(t.engine.getUsageSources(), t.registry.statuses()) }; });
}
