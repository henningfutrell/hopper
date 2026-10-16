// GET /api/accounts: who each part acts as on an outside service (design.md "Usage and accounts
// (issue #18)"). Read-only, and facts only: each usage source's account (its state) and each job
// source's (`detail.account` in its status) — a part describes its own, so a custom plugin's appears
// the same way. Never a token: no part puts one there, and nothing else is read.
// GET /api/tool-accounts (issue #1128, design.md "Tool accounts"): the same usage sources' accounts by service and identity, with
// the machines that use each, their sign-in, when each last ran a job, the infra credentials each job user holds (part 7, issue #1248), and each
// account's week windows.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { machineOf } from '../failures/evidence.ts';
import { lastAccountOf, type Account, type Job, type LastAccount, type PartAccount, type SourceStatus, type ToolAccount, type ToolAccountMachine, type ToolLogin, type UsageReading, type UsageSourceReport } from '../domain/types.ts';
import type { Operation } from './openapi-operation.ts';
import type { TenantParts } from './tenants.ts';

const isAccount = (v: unknown): v is Account =>
  typeof v === 'object' && v !== null && typeof (v as Account).service === 'string' && typeof (v as Account).detail === 'object';

export function accountsOf(usage: UsageSourceReport[], sources: SourceStatus[]): PartAccount[] {
  return [
    ...usage.flatMap((u) => (u.account ? [{ role: 'usage-source' as const, instance: u.name, ...u.account }] : [])),
    ...sources.flatMap((s) => (isAccount(s.detail.account) ? [{ role: 'job-source' as const, instance: s.name, ...s.detail.account }] : [])),
  ];
}

const loginOf = (signedOut: boolean | undefined, identity: string | undefined): ToolLogin =>
  signedOut ? 'signed-out' : identity ? 'signed-in' : 'unknown';

const latest = (xs: (string | undefined)[]): string | undefined =>
  xs.filter((x): x is string => x !== undefined).sort().at(-1);

/**
 * The tool accounts, from the usage sources (an account with a `machine` in its detail is a tool's on that machine), their readings, the
 * machines' labels, and the jobs. A source with no account read yet is left out: it names no machine. In the sources' order.
 */
export function toolAccountsOf(o: {
  sources: UsageSourceReport[]; readings: UsageReading[]; labels: ReadonlyMap<string, string>; jobs: readonly Job[];
  /** The infra credentials each machine's job user holds, as its last read found them (issues #1128 part 7, #1248). */
  infraCredentials?: ReadonlyMap<string, readonly string[]>;
  /** Who a machine's tool of a service was last signed in as (issue #1269): `null` when none is known, `undefined` when not read. */
  lastAccount?: (machineId: string, service: string) => LastAccount | null | undefined;
}): ToolAccount[] {
  const started = new Map<string, Job[]>();
  for (const j of o.jobs) {
    const m = j.startedAt ? machineOf(j) : undefined;
    if (m) started.set(m, [...(started.get(m) ?? []), j]);
  }
  const byKey = new Map<string, ToolAccount>();
  for (const s of o.sources) {
    const a = s.account;
    const machineId = a && typeof a.detail.machine === 'string' ? a.detail.machine : undefined;
    if (!a || !machineId) continue;
    const { machine: _machine, ...detail } = a.detail;
    const login = loginOf(a.signedOut, a.identity);
    const problem = a.problem ?? s.problem;
    const lastUsedAt = latest((started.get(machineId) ?? []).filter((j) => !s.executors || s.executors.includes(j.spec.executor)).map((j) => j.startedAt));
    const creds = o.infraCredentials?.get(machineId);
    // A machine not signed in says who to sign it in as (issue #1269).
    const lastAccount = login === 'signed-in' ? undefined : o.lastAccount?.(machineId, a.service);
    const machine: ToolAccountMachine = {
      machineId, label: o.labels.get(machineId) ?? machineId, source: s.name, login,
      ...(problem ? { problem } : {}), ...(s.accountReadAt ? { readAt: s.accountReadAt } : {}), ...(lastUsedAt ? { lastUsedAt } : {}), ...(s.signIn ? { signIn: true as const } : {}),
      ...(creds?.length ? { infraCredentials: [...creds] } : {}), ...(lastAccount !== undefined ? { lastAccount } : {}),
    };
    // Signed in as nobody, or not known: one entry per service, so a machine signed out is seen beside the accounts.
    const key = `${a.service}\u0000${login === 'signed-in' ? a.identity : `\u0000${login}`}`;
    const had = byKey.get(key);
    if (had) {
      had.machines.push(machine);
      had.detail = { ...detail, ...had.detail };
    } else {
      byKey.set(key, { service: a.service, ...(login === 'signed-in' ? { identity: a.identity } : {}), detail: login === 'signed-in' ? detail : {}, login, machines: [machine], spend: [] });
    }
  }
  return [...byKey.values()].map((acc) => {
    const sources = new Set(acc.machines.filter((m) => m.login === 'signed-in').map((m) => m.source));
    const windows = new Map<string, UsageReading>();
    for (const r of o.readings) {
      if (!sources.has(r.source) || !r.window?.startsWith('week')) continue;
      const had = windows.get(r.window);
      if (!had || r.at > had.at) windows.set(r.window, r);
    }
    const spend = [...windows.values()].sort((x, y) => Number(!!x.informational) - Number(!!y.informational) || x.window!.localeCompare(y.window!));
    const lastUsedAt = latest(acc.machines.map((m) => m.lastUsedAt));
    return { ...acc, spend, ...(lastUsedAt ? { lastUsedAt } : {}) };
  });
}

/** Its operation in the API reference: its scope is in the State and usage section. */
export const TOOL_ACCOUNT_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/tool-accounts', tag: 'State', summary: 'The tool accounts: who each machine\'s agent tool is signed in as', description: 'Per service and identity, from the usage sources\' accounts: the machines that use it, whether each is signed in, signed out or not known, when its source last read it, when a job last started there, the infra credentials its job user holds (`infraCredentials`, names only: a warning, issue #1467), on a machine not signed in who it was last signed in as (`lastAccount`, the label only, `null` when none is known), and the account\'s week windows. Machines signed out are one entry with no identity. Never a token.', returns: '`{ accounts: ToolAccount[] }`' },
];

export function accountRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/accounts', async (req) => { const t = o.tenant(req); return { accounts: accountsOf(t.engine.getUsageSources(), t.registry.statuses()) }; });
  app.get('/api/tool-accounts', async (req) => {
    const t = o.tenant(req);
    const [machines, readings] = await Promise.all([t.engine.getMachines(), t.engine.getUsage()]);
    const labels = new Map(machines.map((m) => [m.id, m.label || m.id]));
    const infraCredentials = new Map(machines.flatMap((m) => (m.infraCredentials ? [[m.id, m.infraCredentials] as const] : [])));
    return { accounts: toolAccountsOf({ sources: t.engine.getUsageSources(), readings, labels, jobs: t.store.jobs.list(), infraCredentials,
      lastAccount: (machineId, service) => lastAccountOf(t.store.lastAccounts, machineId, service) }) };
  });
}
