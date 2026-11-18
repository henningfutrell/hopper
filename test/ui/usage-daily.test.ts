// @vitest-environment happy-dom
// Issue #2966: the `claude-analytics` usage source reads daily usage of Claude Enterprise seats from the Analytics API, but the
// Usage page showed none of it. Its panel now shows one row for each matched account — the day's cost, tokens, sessions,
// commits, pull requests and lines —, labelled "daily, one day late"; "no account matched" for each account no user matched;
// the "analytics key not configured" state with its steps; and the key itself: its status for everyone, and for an admin a
// form that sets or removes it (POST /ui/api/claude-analytics-key).
//
// Feature: daily usage from the Analytics API, on the Usage page
//   Scenario: the model writes one account's day in short words
//   Scenario: a source with daily usage shows each matched account's day, the label and each unmatched account
//   Scenario: a source with no key shows the not-configured state and its steps; an admin sets the key there
//   Scenario: an admin removes a key that is set
//   Scenario: a viewer sees the key's status and no form
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalyticsKeyView, DailyUsage } from '../../src/domain/usage.ts';

// Browser code, type-checked by ui/tsconfig.json: imported by path.
const MODEL = '../../ui/src/model/daily-usage.ts';
interface DailyModel { dayFacts(d: DailyUsage): { cost: string; tokens: string; work: string } }

const SEAT = 'seat@example.com';
const DAY: DailyUsage = {
  account: SEAT, date: '2026-11-17', costCents: 1234,
  tokens: { input: 1000, output: 500, cacheRead: 2500, cacheCreation: 0 },
  sessions: 3, commits: 4, pullRequests: 2, linesAdded: 120, linesRemoved: 30, toolActions: { accepted: 9, rejected: 1 },
};
const NOT_CONFIGURED = 'analytics key not configured: the organization\'s Primary Owner makes a key with the read:analytics scope '
  + '(claude.ai → Organization settings → API), and an admin sets it on Usage';

describe('one account\'s day (issue #2966)', () => {
  it('writes the cost, the tokens and the work of the day', async () => {
    const { dayFacts } = (await import(MODEL)) as DailyModel;
    expect(dayFacts(DAY)).toEqual({ cost: '$12.34', tokens: '4.0k tokens', work: '3 sessions · 4 commits · 2 pull requests · +120 −30 lines' });
    expect(dayFacts({ ...DAY, sessions: 1, commits: 1, pullRequests: 1 }).work).toBe('1 session · 1 commit · 1 pull request · +120 −30 lines');
  });
});

let calls: { method: string; path: string; body?: unknown }[] = [];
let usage: () => unknown = () => ({});
let key: AnalyticsKeyView = { set: false };
let role = 'admin';

function fakeDaemon() {
  const routes: Record<string, () => unknown> = {
    '/api/health': () => ({ ok: true, version: '0', router: 'pass-through', fallback: false, executors: ['herdr-claude'], uptimeS: 1 }),
    '/api/queue': () => ({ waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], waitingOn: [], ended: [], locked: [] }),
    '/api/machines': () => ({ machines: [] }), '/api/decisions': () => ({ decisions: [] }), '/api/events': () => ({ events: [] }),
    '/api/webhooks': () => ({ subscriptions: [] }), '/api/webhooks/deliveries': () => ({ deliveries: [] }),
    '/api/questions': () => ({ questions: [] }), '/api/sources': () => ({ sources: [] }), '/api/usage': () => usage(), '/api/accounts': () => ({ accounts: [] }),
    '/api/credential-check': () => ({ strict: false }), '/api/claude-analytics-key': () => key,
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = String(input).split('?')[0]!;
    const body = init.body ? JSON.parse(String(init.body)) as { action: string; value?: string } : undefined;
    calls.push({ method: init.method ?? 'GET', path, ...(body ? { body } : {}) });
    if (init.method === 'POST' && path === '/ui/api/claude-analytics-key') {
      key = body!.action === 'set' ? { set: true, last4: body!.value!.slice(-4), setAt: '2026-11-18T10:00:00.000Z', setBy: 'admin' } : { set: false };
      return json(key);
    }
    if (path === '/ui/api/session') return json({ authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role, realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
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
const ANALYTICS = { name: 'claude-analytics', informational: true, refreshedAt: new Date().toISOString() };
let root: Root | undefined;

async function boot(source: Record<string, unknown>, ready: string, as = 'admin') {
  calls = [];
  role = as;
  usage = () => ({ readings: [], sources: [{ ...ANALYTICS, ...source }], limits: LIMITS, machines: [] });
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

const slot = (name: string) => document.querySelector(`[data-slot="${name}"]`);
const text = (name: string) => slot(name)?.textContent ?? '';
const keyInput = () => document.querySelector<HTMLInputElement>('input[aria-label="Claude Analytics API key"]');
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[data-slot="usage-analytics-key"] button')].find((b) => b.textContent === label);

async function type(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => { set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  key = { set: false };
  vi.unstubAllGlobals();
});

describe('the Usage page of the claude-analytics source (issue #2966)', () => {
  it('shows each matched account\'s day, the daily label and each unmatched account, and reads no token ledger', async () => {
    key = { set: true, last4: 'abcd' };
    await boot({ daily: { date: '2026-11-17', days: [DAY], unmatched: ['alias@example.com'] } }, '[data-slot="usage-daily-row"]');
    expect(text('usage-daily-label')).toMatch(/daily, one day late/i);
    expect(text('usage-daily-label')).toMatch(/2026-11-17/);
    const row = text('usage-daily-row');
    expect(row).toContain(SEAT);
    expect(row).toContain('$12.34');
    expect(row).toContain('4.0k tokens');
    expect(row).toContain('3 sessions · 4 commits · 2 pull requests · +120 −30 lines');
    expect(text('usage-daily-unmatched')).toMatch(/alias@example\.com: no account matched/);
    expect(document.body.textContent).not.toMatch(/no readings now/);
    expect(slot('usage-account-ledger')).toBeNull();
    expect(calls.some((c) => c.path === '/api/usage/tokens')).toBe(false);
  });

  it('shows the not-configured state and its steps, and an admin sets the key there', async () => {
    await boot({ notConfigured: NOT_CONFIGURED }, '[data-slot="usage-daily-not-configured"]');
    expect(text('usage-daily-not-configured')).toMatch(/analytics key not configured/);
    expect(text('usage-daily-not-configured')).toMatch(/read:analytics/);
    await vi.waitFor(() => expect(keyInput()).not.toBeNull());
    expect(text('usage-analytics-key-status')).toBe('Not set');
    await type(keyInput()!, 'sk-ant-admin-key-wxyz');
    await act(async () => { button('Save')!.click(); });
    await vi.waitFor(() => expect(text('usage-analytics-key-status')).toMatch(/^Set — ends in wxyz/));
    expect(calls.filter((c) => c.method === 'POST')).toEqual([{ method: 'POST', path: '/ui/api/claude-analytics-key', body: { action: 'set', value: 'sk-ant-admin-key-wxyz' } }]);
    expect(keyInput()!.value).toBe('');
  });

  it('lets an admin remove a key that is set', async () => {
    key = { set: true, last4: 'abcd', setAt: '2026-11-18T09:00:00.000Z', setBy: 'admin' };
    await boot({ daily: { date: '2026-11-17', days: [DAY], unmatched: [] } }, '[data-slot="usage-analytics-key-status"]');
    await vi.waitFor(() => expect(text('usage-analytics-key-status')).toMatch(/ends in abcd/));
    expect(button('Replace')).toBeDefined();
    await act(async () => { button('Remove')!.click(); });
    await vi.waitFor(() => expect(text('usage-analytics-key-status')).toBe('Not set'));
    expect(calls.filter((c) => c.method === 'POST')).toEqual([{ method: 'POST', path: '/ui/api/claude-analytics-key', body: { action: 'remove' } }]);
  });

  it('shows a viewer the key\'s status and no form', async () => {
    await boot({ notConfigured: NOT_CONFIGURED }, '[data-slot="usage-analytics-key-status"]', 'viewer');
    await vi.waitFor(() => expect(text('usage-analytics-key-status')).toBe('Not set'));
    expect(keyInput()).toBeNull();
    expect(button('Save')).toBeUndefined();
  });
});
