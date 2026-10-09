// @vitest-environment happy-dom
// Issue #565, rendered inside the whole app against a fake of the daemon's HTTP surface: a parked job's question leaves
// Questions, its badge and Attention; the job is a compact row in Parked — issue title and number, machine, when it was
// parked, the question's first line, whether its agent session resumes — high priority first. Expanded, the full
// question; Pick up re-queues it, Answer and pick up sends the answer and re-queues it in one step, and a viewer reads only.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Role = 'viewer' | 'admin';
const T = '2026-10-09T12:00:00.000Z';
const job = (id: string, number: number, priority: number, title: string, over: Record<string, unknown>) => ({
  id, spec: { executor: 'herdr-claude', payload: {} }, priority, status: 'waiting_answer', approved: true, attempts: 1, questionId: `q-${id}`,
  createdAt: T, updatedAt: T, source: { source: 'github', kind: 'github', key: `k-${id}`, title, repo: 'o/r', number }, ...over,
});
const parked = (at: string, over: Record<string, unknown> = {}) => ({ status: 'parked', resumeOn: 'desk', parked: { at, from: 'waiting_answer' }, ...over });
const question = (id: string, text: string, high: boolean) => ({
  id: `q-${id}`, jobId: id, text, recentOutput: '', detectedBy: 'marker', status: 'open', tier: 'human', attempts: [], notifyCount: 1,
  createdAt: T, updatedAt: T, seenAt: T, priority: high ? 80 : 50, high,
});

function fakeDaemon(role: Role) {
  const posts: { path: string; body: unknown }[] = [];
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: ['herdr-claude'], parkingExecutors: ['herdr-claude'], uptimeS: 1 },
    '/api/queue': {
      waiting: [], running: [], operatorLed: [], ended: [], locked: [], highPriority: 75,
      waitingAnswer: [job('live', 1, 50, 'Answer me now', {})],
      // Oldest parked first, as the queue answers them; the high-priority one is newer, and resumes its session.
      parked: [
        job('old', 2, 50, 'Tidy the docs', parked('2026-10-09T09:00:00.000Z')),
        job('later', 3, 80, 'Fix the outage', parked('2026-10-09T11:00:00.000Z', { agentSession: '11111111-1111-1111-1111-111111111111' })),
      ],
    },
    '/api/machines': { machines: [{ id: 'desk', label: 'desk', maxLanes: 2, online: true, executors: ['herdr-claude'], lanes: [], usage: [] }] },
    '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] }, '/api/sources': { sources: [] },
    '/api/questions': { questions: [
      question('live', 'Which port?', false),
      question('old', 'Should the docs keep the old section?\nIt is linked from two places.', false),
      question('later', 'Roll back or patch forward?\nThe patch is ready but untested.', true),
    ] },
    '/api/accounts': { accounts: [] }, '/api/usage': { readings: [], sources: [], machines: [], limits: { soft: 0.7, hard: 0.95, defaults: { soft: 0.7, hard: 0.95 }, set: false } },
    '/api/logins': { now: T, settings: { onExpiry: 'fail', warnSec: 60 }, logins: [] },
    // The Overview's graphs: no samples.
    '/api/usage/history': { view: { range: { preset: '24h' } }, from: '2026-10-08T12:00:00.000Z', to: T, stepMs: 900000, retentionDays: 90, series: [] },
    '/api/machines/history': { view: { range: { preset: '24h' } }, from: '2026-10-08T12:00:00.000Z', to: T, stepMs: 900000, retentionDays: 90, series: [] },
  };
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const [path] = String(input).split('?') as [string];
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role, realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (path.startsWith('/ui/api/')) { posts.push({ path, body: JSON.parse(String(init.body ?? '{}')) }); return json(200, {}); }
    return json(200, routes[path] ?? {});
  });
  return { fetch, posts };
}

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

let root: Root | undefined;
let daemon: ReturnType<typeof fakeDaemon>;

async function boot(role: Role, hash: string) {
  window.location.hash = hash;
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  daemon = fakeDaemon(role);
  vi.stubGlobal('fetch', daemon.fetch);
  vi.stubGlobal('EventSource', FakeEventSource);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx';
  const mod = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(mod.App)); });
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const navBadge = (href: string) => [...document.querySelectorAll('[data-slot="nav-badge"]')].find((b) => b.closest('a')?.getAttribute('href') === href);
const row = (id: string) => document.querySelector(`[data-parked-job="${id}"]`)!;
const buttonIn = (el: Element, label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
function type(el: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('a parked job\'s question', () => {
  it('leaves Questions and its badge; Parked has its own count, marked for a high-priority job', async () => {
    await boot('admin', '#questions');
    expect([...document.querySelectorAll('[data-question]')].map((c) => c.getAttribute('data-question'))).toEqual(['q-live']);
    expect(navBadge('#questions')!.getAttribute('title')).toBe('1 question waits on you');
    const badge = navBadge('#parked')!;
    expect(badge.textContent).toBe('2');
    expect(badge.getAttribute('data-high')).toBe('1');
    expect(badge.getAttribute('title')).toBe('2 parked jobs wait to be picked up; 1 high priority');
  });

  it('leaves Attention', async () => {
    await boot('admin', '#overview');
    expect(document.querySelector('[data-notice="question:q-live"]')).not.toBeNull();
    expect(document.querySelector('[data-notice="question:q-later"]')).toBeNull();
    expect(document.querySelector('[data-notice="question:q-old"]')).toBeNull();
  });
});

describe('the Parked section', () => {
  it('one compact row per job, high priority first: title and number, machine, the question\'s first line, whether it resumes', async () => {
    await boot('admin', '#parked');
    expect([...document.querySelectorAll('[data-parked-job]')].map((r) => r.getAttribute('data-parked-job'))).toEqual(['later', 'old']);
    const later = row('later');
    expect(later.textContent).toContain('Fix the outage');
    expect(later.textContent).toContain('r#3');
    expect(later.textContent).toContain('desk');
    expect(later.querySelector('[data-slot="parked-since"]')).not.toBeNull();
    expect(later.querySelector('[data-slot="question-line"]')!.textContent).toBe('Roll back or patch forward?');
    expect(later.querySelector('[data-slot="resumes"]')!.textContent).toBe('resumes its session');
    expect(row('old').querySelector('[data-slot="resumes"]')!.textContent).toBe('starts fresh');
    // Compact: the full question only once expanded.
    expect(later.textContent).not.toContain('The patch is ready but untested.');
    await act(async () => { (later.querySelector('[aria-label="Show the question"]') as HTMLButtonElement).click(); });
    expect(row('later').textContent).toContain('The patch is ready but untested.');
  });

  it('Pick up re-queues the job, resuming its session', async () => {
    await boot('admin', '#parked');
    await act(async () => { buttonIn(row('later'), 'Pick up')!.click(); });
    await settle();
    expect(daemon.posts).toEqual([{ path: '/ui/api/jobs/later/requeue', body: {} }]);
  });

  it('Answer and pick up sends the answer, then re-queues the job', async () => {
    await boot('admin', '#parked');
    await act(async () => { (row('later').querySelector('[aria-label="Show the question"]') as HTMLButtonElement).click(); });
    await act(async () => { type(row('later').querySelector('textarea')!, 'Patch forward.'); });
    await act(async () => { buttonIn(row('later'), 'Answer and pick up')!.click(); });
    await settle();
    expect(daemon.posts).toEqual([
      { path: '/ui/api/questions/q-later/answer', body: { answer: 'Patch forward.' } },
      { path: '/ui/api/jobs/later/requeue', body: {} },
    ]);
  });

  it('a viewer reads only', async () => {
    await boot('viewer', '#parked');
    expect(document.querySelectorAll('[data-parked-job]')).toHaveLength(2);
    expect(buttonIn(row('later'), 'Pick up')).toBeUndefined();
    expect(row('later').querySelector('[aria-label="Cancel job"]')).toBeNull();
  });
});
