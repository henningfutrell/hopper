// @vitest-environment happy-dom
// Issue #2966: an account with no usage limits (an Enterprise plan, issue #2932) has no session or weekly window, so its usage
// source's panel on the Usage page showed nothing. It now shows that account's token ledger: tokens and the estimated cost today
// and over the last 7 days, and the last 30 days, from GET /api/usage/tokens?by=day&split=account. The label says it is an
// estimate from the hopper's own jobs at list prices.
//
// Feature: the token ledger of an account with no usage limits, on the Usage page
//   Scenario: the model sums one account's parts today and over 7 days, and leaves other accounts out
//   Scenario: a source read with no reading and no problem has no usage limits; one with a reading or a problem has
//   Scenario: the source's panel shows the account's ledger and the estimate label in place of "no readings now"
//   Scenario: a source with readings shows its windows and reads no ledger
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TokenRollupRow } from '../../src/domain/token-usage.ts';
import type { UsageReading, UsageSourceReport } from '../../src/domain/usage.ts';

// Browser code, type-checked by ui/tsconfig.json: imported by path.
const LEDGER = '../../ui/src/model/token-ledger.ts';
const USAGE = '../../ui/src/model/usage.ts';

interface TokenSum { tokens: number; costUsd: number; costKnown: boolean }
interface LedgerModel { accountLedger(groups: TokenRollupRow[], account: string, days: number, today: string): { today: TokenSum; week: TokenSum; days: { day: string; tokens: number }[] } }
interface UsageModel { noUsageLimits(s: UsageSourceReport, readings: Pick<UsageReading, 'source'>[]): boolean }

const ACCOUNT = 'seat@example.com';
const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.parse(`${today}T00:00:00.000Z`) - n * 86_400_000).toISOString().slice(0, 10);
const totals = (input: number, costUsd: number, costKnown = true) => ({ turns: 1, input, output: 0, cacheRead: 0, cacheWrite: 0, costUsd, costKnown });
const part = (key: string, input: number, costUsd: number, costKnown = true): TokenRollupRow => ({ key, jobs: 1, ...totals(input, costUsd, costKnown) });
const day = (key: string, parts: TokenRollupRow[]): TokenRollupRow =>
  ({ key, jobs: parts.length, ...totals(parts.reduce((n, p) => n + p.input, 0), parts.reduce((n, p) => n + p.costUsd, 0)), parts });

const GROUPS = [
  day(today, [part(ACCOUNT, 1200, 1.5), part('other@example.com', 9000, 9)]),
  day(daysAgo(3), [part(ACCOUNT, 800, 0.5, false)]),
  day(daysAgo(10), [part(ACCOUNT, 5000, 4)]),
];

describe('the token ledger of an account with no usage limits (issue #2966)', () => {
  it('sums one account today and over 7 days, and leaves other accounts out', async () => {
    const { accountLedger } = (await import(LEDGER)) as LedgerModel;
    const l = accountLedger(GROUPS, ACCOUNT, 30, today);
    expect(l.today).toEqual({ tokens: 1200, costUsd: 1.5, costKnown: true });
    expect(l.week).toEqual({ tokens: 2000, costUsd: 2, costKnown: false });
    expect(l.days).toHaveLength(30);
    expect(l.days.reduce((n, d) => n + d.tokens, 0)).toBe(7000);
    expect(accountLedger(GROUPS, 'nobody@example.com', 30, today).week).toEqual({ tokens: 0, costUsd: 0, costKnown: true });
  });

  it('reads a source with no reading and no problem as one with no usage limits', async () => {
    const { noUsageLimits } = (await import(USAGE)) as UsageModel;
    const read = { name: 'claude-usage', refreshedAt: '2026-11-18T10:00:00.000Z' };
    expect(noUsageLimits(read, [])).toBe(true);
    expect(noUsageLimits(read, [{ source: 'claude-usage' }])).toBe(false);
    expect(noUsageLimits({ ...read, problem: 'not read yet' }, [])).toBe(false);
    expect(noUsageLimits({ name: 'claude-usage' }, [])).toBe(false);
  });
});

let calls: string[] = [];
let usage: () => unknown = () => ({});

function fakeDaemon() {
  const routes: Record<string, () => unknown> = {
    '/api/health': () => ({ ok: true, version: '0', router: 'pass-through', fallback: false, executors: ['herdr-claude'], uptimeS: 1 }),
    '/api/queue': () => ({ waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], waitingOn: [], ended: [], locked: [] }),
    '/api/machines': () => ({ machines: [] }), '/api/decisions': () => ({ decisions: [] }), '/api/events': () => ({ events: [] }),
    '/api/webhooks': () => ({ subscriptions: [] }), '/api/webhooks/deliveries': () => ({ deliveries: [] }),
    '/api/questions': () => ({ questions: [] }), '/api/sources': () => ({ sources: [] }), '/api/usage': () => usage(), '/api/accounts': () => ({ accounts: [] }),
    '/api/credential-check': () => ({ strict: false }),
    '/api/usage/tokens': () => ({ by: 'day', total: totals(7000, 6), groups: GROUPS, top: [], waste: [], perMerged: { pullRequests: 0 } }),
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string) => {
    calls.push(String(input));
    const path = String(input).split('?')[0]!;
    if (path === '/ui/api/session') return json({ authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'viewer', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    return path in routes ? json(routes[path]!()) : new Response('{"error":"not found"}', { status: 404 });
  });
}

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

const LIMITS = { soft: 0.7, hard: 0.95, softLanes: 1, defaults: { soft: 0.7, hard: 0.95, softLanes: 1 }, set: false };
const SOURCE = { name: 'claude-usage', refreshedAt: new Date().toISOString(), account: { service: 'claude', identity: ACCOUNT, detail: {} } };
let root: Root | undefined;

async function boot(report: unknown, ready: string) {
  calls = [];
  usage = () => report;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#usage';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', fakeDaemon());
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx';
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(document.querySelector(ready)).not.toBeNull());
}

const text = (slot: string) => document.querySelector(`[data-slot="${slot}"]`)?.textContent;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('the Usage page of an account with no usage limits (issue #2966)', () => {
  it('shows the account\'s token ledger and says it is an estimate, in place of no readings', async () => {
    await boot({ readings: [], sources: [SOURCE], limits: LIMITS, machines: [] }, '[data-slot="usage-account-today"]');
    expect(text('usage-account-today')).toBe('1.2k tokens · $1.50');
    expect(text('usage-account-week')).toBe('2.0k tokens · ~$2.00');
    expect(text('usage-account-note')).toMatch(/estimated from the hopper's own jobs \(list prices\)/);
    expect(text('usage-account-note')).toMatch(/not the billed cost/);
    expect(document.body.textContent).not.toMatch(/no readings now/);
    expect(calls.find((c) => c.startsWith('/api/usage/tokens'))).toMatch(/by=day&split=account&since=/);
  });

  it('shows the windows of a source with readings, and reads no ledger', async () => {
    const reading = { source: 'claude-usage', window: 'session', used: 40, limit: 100, unit: '%', readAt: new Date().toISOString() };
    await boot({ readings: [reading], sources: [SOURCE], limits: LIMITS, machines: [] }, '[data-slot="usage-now-value"]');
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(document.querySelector('[data-slot="usage-account-ledger"]')).toBeNull();
    expect(calls.some((c) => c.startsWith('/api/usage/tokens'))).toBe(false);
  });
});
