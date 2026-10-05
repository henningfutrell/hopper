// @vitest-environment happy-dom
// Issue #83: notices in the UI can be dismissed. Each Attention item and the update notice has a
// Dismiss button; a dismissed notice leaves this browser's view and stays gone after a reload, and
// nothing goes to the daemon — the question it pointed at stays open. "Show dismissed" brings the
// Attention items back. The app renders against a fake of the daemon's HTTP surface and a fake SSE.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const KEY = 'jh_dismissed';
const at = '2026-10-05T10:00:00.000Z';
const question = {
  id: 'q1', jobId: 'j1', text: 'Which branch?', recentOutput: '', detectedBy: 'marker', status: 'open',
  tier: 'human', attempts: [], notifyCount: 1, createdAt: at, updatedAt: at,
};
const failed = { id: 'j2', spec: { executor: 'test', payload: {}, goal: 'goal j2' }, priority: 50, status: 'failed', approved: false, createdAt: at, updatedAt: at, finishedAt: at, attempts: 1, error: 'exit 1' };
const update = {
  state: 'available', channel: 'main', autoUpdate: false, target: { commit: 'b'.repeat(40), ref: 'main' },
  whatsNew: ['You can pause the queue.'], installedWhatsNew: [], installed: { repo: 'r', branch: 'main', commit: 'a'.repeat(40), installedAt: at },
};

let calls: { path: string; method: string }[] = [];

function fakeDaemon() {
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', routerMode: 'active', router: 'jev', fallback: true, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], waitingAnswer: [], ended: [failed] },
    '/api/machines': { machines: [] },
    '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] },
    '/api/questions': { questions: [question] },
    '/api/sources': { sources: [{ name: 'gh', kind: 'github', state: 'error', lastError: 'HTTP 401', lastSyncAt: at, itemsSeen: 0, jobsCreated: 0 }] },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
    '/api/update': update,
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = String(input).split('?')[0]!;
    calls.push({ path, method: init.method ?? 'GET' });
    if (path === '/ui/api/session') return json({ authenticated: false });
    return path in routes ? json(routes[path]) : new Response('{"error":"not found"}', { status: 404 });
  });
}

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

let root: Root | undefined;

async function boot(stored?: string, o: { notice: boolean } = { notice: true }) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#overview';
  localStorage.clear();
  if (stored !== undefined) localStorage.setItem(KEY, stored);
  calls = [];
  vi.stubGlobal('fetch', fakeDaemon());
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(attention()).not.toBeNull());
  await vi.waitFor(() => expect(calls.some((c) => c.path === '/api/update')).toBe(true));
  if (o.notice) await vi.waitFor(() => expect(notice()).not.toBeNull());
}

async function reload(o?: { notice: boolean }) {
  const stored = localStorage.getItem(KEY) ?? undefined;
  await act(async () => root?.unmount());
  await boot(stored, o);
}

const attention = () => document.querySelector<HTMLElement>('[data-overview-panel="attention"]');
const items = () => [...attention()!.querySelectorAll<HTMLElement>('[data-notice]')].map((e) => e.dataset.notice);
const notice = () => document.querySelector<HTMLElement>('[data-update-notice]');
const button = (scope: ParentNode, name: string) =>
  [...scope.querySelectorAll<HTMLElement>('button')].find((b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name);

async function click(el: Element | null | undefined) {
  expect(el).toBeTruthy();
  await act(async () => { (el as HTMLElement).click(); });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('Dismissing notices', () => {
  it('every Attention item and the update notice offers Dismiss', async () => {
    await boot();
    expect(items()).toEqual(['question:q1', 'router:jev', 'source:gh:HTTP 401', 'failed:j2']);
    for (const el of attention()!.querySelectorAll('[data-notice]')) expect(button(el, 'Dismiss')).toBeTruthy();
    expect(button(notice()!, 'Dismiss')).toBeTruthy();
  });

  it('a dismissed Attention item leaves the panel, stays gone after a reload, and changes nothing at the daemon', async () => {
    await boot();
    await click(button(attention()!.querySelector('[data-notice="question:q1"]')!, 'Dismiss'));
    expect(items()).toEqual(['router:jev', 'source:gh:HTTP 401', 'failed:j2']);
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);

    await reload();
    expect(items()).toEqual(['router:jev', 'source:gh:HTTP 401', 'failed:j2']);
  });

  it('dismissing every item: the panel says so, and Show dismissed brings them back', async () => {
    await boot();
    for (const key of ['question:q1', 'router:jev', 'source:gh:HTTP 401', 'failed:j2']) {
      await click(button(attention()!.querySelector(`[data-notice="${key}"]`)!, 'Dismiss'));
    }
    expect(items()).toEqual([]);
    expect(attention()!.textContent).toContain('4 dismissed');
    await click(button(attention()!, 'Show dismissed'));
    expect(items()).toEqual(['question:q1', 'router:jev', 'source:gh:HTTP 401', 'failed:j2']);
  });

  it('a dismissed update notice stays gone after a reload', async () => {
    await boot();
    await click(button(notice()!, 'Dismiss'));
    expect(notice()).toBeNull();
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);

    await reload({ notice: false });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(notice()).toBeNull();
  });

  it('a toast has a close button', async () => {
    await boot();
    const { toast } = await import('sonner');
    await act(async () => { toast.error('Clipboard blocked'); });
    await vi.waitFor(() => expect(document.querySelector('[data-sonner-toast]')).not.toBeNull());
    const toastEl = document.querySelector('[data-sonner-toast]')!;
    await click(button(toastEl, 'Close toast'));
  });
});
