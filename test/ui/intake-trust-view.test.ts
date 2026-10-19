// @vitest-environment happy-dom
// Issue #655: the Intake view of the stamp, rendered inside the whole app against a fake of the daemon's HTTP surface. The
// waiting jobs a trust stamp holds are listed in Intake, with why and the act that lets each go on; the nav badge counts the
// ones that wait on a person.
//
// Feature: Held by trust in Intake
//   Scenario: each held job shows its level, why it is held and a link to the job; another hold is not listed
//   Scenario: an operator approves a lowered job's trust, after a confirm, and lifts a quarantine
//   Scenario: the nav badge counts the held jobs that wait on a person, not one Jev still checks
//   Scenario: an operator cancels a held job from its row, after a confirm (issue #1974)
//   Scenario: an operator approves the trust of a held job with no item (issue #1974)
//   Scenario: a viewer reads the list and gets no button
//   Scenario: with no job held by trust, Intake shows no such panel
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { CHECK_PENDING, QUARANTINED_HOLD, STAMP_MISSING } from '../../src/domain/trust-stamp.ts';
import { ORIGIN_PENDING } from '../../src/decider/index.ts';

const T = '2026-10-17T12:00:00.000Z';
const stamp = (level: string, reasons = ['origin:approved']) => ({ v: 1, level, reasons, by: 'intake', at: T, mac: 'm' });
const base = { spec: { executor: 'herdr-claude', payload: {}, goal: 'Fix the parser' }, priority: 50, status: 'held', approved: true, attempts: 0, createdAt: T, updatedAt: T };
const BELOW = 'trust stamp untrusted is below approved (Jev\'s trust check: it changes CI, workflow files or branch rules): held — a person approves its trust on the job, or cancels it';
const lowered = { ...base, id: 'l1', holdReason: BELOW, stamp: { ...stamp('untrusted', ['origin:approved', 'jev:touches_ci']), by: 'jev' } } as unknown as Job;
const quarantined = { ...base, id: 'q1', spec: { ...base.spec, goal: 'Update the deps' }, holdReason: QUARANTINED_HOLD, stamp: { ...stamp('quarantined'), was: 'trusted', by: 'person' } } as unknown as Job;
const missing = { ...base, id: 'm1', spec: { ...base.spec, goal: 'Old job' }, holdReason: STAMP_MISSING } as unknown as Job;
const checking = { ...base, id: 'c1', spec: { ...base.spec, goal: 'Being checked' }, holdReason: CHECK_PENDING, stamp: stamp('approved') } as unknown as Job;
const NO_ITEM = 'trust stamp untrusted is below approved: held — a person approves its trust on the job, or cancels it';
const bare = { ...base, id: 'u1', spec: { ...base.spec, goal: 'Queued by hand' }, holdReason: NO_ITEM, stamp: stamp('untrusted', ['source:none']) } as unknown as Job;
const pending = { ...base, id: 'o1', spec: { ...base.spec, goal: 'Origin pending' }, holdReason: ORIGIN_PENDING, originPending: true } as unknown as Job;

let calls: { method: string; path: string; body?: unknown }[] = [];

function fakeDaemon(role: 'operator' | 'viewer', waiting: Job[]) {
  const routes: Record<string, () => unknown> = {
    '/api/health': () => ({ ok: true, version: '0', router: 'pass-through', fallback: false, executors: ['herdr-claude'], uptimeS: 1 }),
    '/api/queue': () => ({ waiting, running: [], operatorLed: [], parked: [], waitingAnswer: [], waitingOn: [], ended: [], locked: [] }),
    '/api/machines': () => ({ machines: [] }), '/api/decisions': () => ({ decisions: [] }), '/api/events': () => ({ events: [] }),
    '/api/webhooks': () => ({ subscriptions: [] }), '/api/webhooks/deliveries': () => ({ deliveries: [] }),
    '/api/questions': () => ({ questions: [] }), '/api/sources': () => ({ sources: [] }),
    '/api/usage': () => ({ readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }), '/api/accounts': () => ({ accounts: [] }),
    '/ui/api/jobs/l1/approve-trust': () => ({ ...lowered, status: 'queued', holdReason: undefined, stamp: { ...stamp('approved'), by: 'person' } }),
    '/ui/api/jobs/u1/approve-trust': () => ({ ...bare, status: 'queued', holdReason: undefined, stamp: { ...stamp('approved'), by: 'person' } }),
    '/ui/api/jobs/m1/cancel': () => ({ ...missing, status: 'cancelled', holdReason: undefined }),
    '/ui/api/jobs/q1/unquarantine': () => ({ ...quarantined, status: 'queued', holdReason: undefined, stamp: stamp('trusted') }),
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = String(input).split('?')[0]!;
    calls.push({ method: init.method ?? 'GET', path, ...(init.body ? { body: JSON.parse(String(init.body)) as unknown } : {}) });
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

let root: Root | undefined;

async function boot(role: 'operator' | 'viewer' = 'operator', waiting: Job[] = [lowered, quarantined, missing, checking, pending]) {
  calls = [];
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#intake';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', fakeDaemon(role, waiting));
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(document.querySelector('[data-intake-page]')).not.toBeNull());
}

const panel = () => document.querySelector<HTMLElement>('[data-intake-trust]');
const rowOf = (id: string) => panel()?.querySelector<HTMLElement>(`[data-trust-held="${id}"]`) ?? null;
const button = (el: ParentNode, text: RegExp) => [...el.querySelectorAll('button')].find((b) => text.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
const dialog = () => vi.waitFor(() => { const d = document.querySelector('[role="alertdialog"]'); expect(d).not.toBeNull(); return d!; });
const posts = () => calls.filter((c) => c.method === 'POST' && c.path.startsWith('/ui/api/jobs/'));

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('Held by trust in Intake (issue #655)', () => {
  it('lists each job its trust stamp holds, with its level, why and a link to it; no other hold', async () => {
    await boot();
    await vi.waitFor(() => expect(panel()).not.toBeNull());
    for (const id of ['l1', 'q1', 'm1', 'c1']) expect(rowOf(id)).not.toBeNull();
    expect(rowOf('o1')).toBeNull();
    const l = rowOf('l1')!;
    expect(l.querySelector('[data-slot="job-trust"]')?.getAttribute('data-level')).toBe('untrusted');
    expect(l.textContent).toContain('Fix the parser');
    expect(l.textContent).toContain('Jev\'s trust check lowered it: it changes CI, workflow files or branch rules');
    expect(l.querySelector('a[href="#job/l1"]')).not.toBeNull();
    expect(rowOf('m1')!.textContent).toContain('no trust stamp');
    expect(rowOf('c1')!.textContent).toContain('Jev checks its trust');
  });

  it('an operator approves a lowered job\'s trust after a confirm, and lifts a quarantine', async () => {
    await boot();
    await vi.waitFor(() => expect(rowOf('l1')).not.toBeNull());
    await act(async () => { button(rowOf('l1')!, /Approve trust/)!.click(); });
    const d = await dialog();
    expect(posts()).toEqual([]);
    await act(async () => { [...d.querySelectorAll('button')].find((b) => b.textContent === 'Approve trust')!.click(); });
    await vi.waitFor(() => expect(posts()).toEqual([{ method: 'POST', path: '/ui/api/jobs/l1/approve-trust', body: {} }]));
    await act(async () => { button(rowOf('q1')!, /Lift quarantine/)!.click(); });
    await vi.waitFor(() => expect(posts().at(-1)).toEqual({ method: 'POST', path: '/ui/api/jobs/q1/unquarantine', body: {} }));
  });

  it('an operator cancels a held job from its row, after a confirm (issue #1974)', async () => {
    await boot();
    await vi.waitFor(() => expect(rowOf('m1')).not.toBeNull());
    for (const id of ['l1', 'q1', 'm1', 'c1']) expect(button(rowOf(id)!, /^Cancel$/)).toBeDefined();
    await act(async () => { button(rowOf('m1')!, /^Cancel$/)!.click(); });
    const d = await dialog();
    expect(posts()).toEqual([]);
    await act(async () => { [...d.querySelectorAll('button')].find((b) => b.textContent === 'Cancel job')!.click(); });
    await vi.waitFor(() => expect(posts()).toEqual([{ method: 'POST', path: '/ui/api/jobs/m1/cancel', body: {} }]));
  });

  it('an operator approves the trust of a held job with no item (issue #1974)', async () => {
    await boot('operator', [bare]);
    await vi.waitFor(() => expect(rowOf('u1')).not.toBeNull());
    await act(async () => { button(rowOf('u1')!, /Approve trust/)!.click(); });
    const d = await dialog();
    await act(async () => { [...d.querySelectorAll('button')].find((b) => b.textContent === 'Approve trust')!.click(); });
    await vi.waitFor(() => expect(posts()).toEqual([{ method: 'POST', path: '/ui/api/jobs/u1/approve-trust', body: {} }]));
  });

  it('the nav badge counts the held jobs that wait on a person, not one Jev still checks', async () => {
    await boot();
    const badge = () => document.querySelector<HTMLElement>('nav a[href="#intake"]')!;
    await vi.waitFor(() => expect(badge().textContent).toContain('3'));
    expect(badge().querySelector('[title]')?.getAttribute('title') ?? badge().innerHTML).toContain('3 jobs held by their trust stamp');
  });

  it('a viewer reads the list and gets no button', async () => {
    await boot('viewer');
    await vi.waitFor(() => expect(rowOf('l1')).not.toBeNull());
    expect(button(panel()!, /Approve trust|Lift quarantine|Quarantine|Cancel/)).toBeUndefined();
  });

  it('with no job held by trust, Intake shows no such panel', async () => {
    await boot('operator', [pending]);
    expect(panel()).toBeNull();
  });
});
