// @vitest-environment happy-dom
// Issue #1116: the leftovers on a Machines card, rendered inside the whole app against a fake of the daemon's HTTP surface.
// Each leftover says its path, what it is, its size and age, and whether it holds work not pushed; Keep posts the decision at
// once, and Remove asks first, saying what is lost, then posts it.
//
// Feature: leftovers a person decides
//   Scenario: the card lists each leftover with what a person needs to decide
//   Scenario: Keep posts the decision; a kept one offers Remove only
//   Scenario: Remove asks first, then posts the decision
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const DAY = 86400_000;
const STRANGER = '/home/me/work/.hopper-scratch/other-hopper-job';
const MIRROR = '/home/me/work/.hopper-scratch/repos/acme/app.git';
const MACHINES = [{
  id: 'desk', label: 'desk', maxLanes: 2, online: true, executors: ['herdr-claude'], lanes: [], usage: [],
  leftovers: { at: '2026-10-16T12:00:00.000Z', items: [
    { path: STRANGER, kind: 'scratch', ageMs: 5 * DAY, unpushed: true, bytes: 2.4e9 },
    { path: MIRROR, kind: 'mirror', ageMs: 9 * DAY, unpushed: false, users: 1, bytes: 340e6, kept: { at: '2026-10-16T11:00:00.000Z', person: 'Pat', via: 'ui' } },
  ] },
}];

let calls: { method: string; path: string; body?: unknown }[] = [];

function fakeDaemon() {
  const routes: Record<string, () => unknown> = {
    '/api/health': () => ({ ok: true, version: '0', router: 'pass-through', fallback: false, executors: ['herdr-claude'], uptimeS: 1 }),
    '/api/queue': () => ({ waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], waitingOn: [], ended: [], locked: [] }),
    '/api/machines': () => ({ machines: MACHINES }), '/api/decisions': () => ({ decisions: [] }), '/api/events': () => ({ events: [] }),
    '/api/webhooks': () => ({ subscriptions: [] }), '/api/webhooks/deliveries': () => ({ deliveries: [] }),
    '/api/questions': () => ({ questions: [] }), '/api/sources': () => ({ sources: [] }),
    '/api/usage': () => ({ readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }), '/api/accounts': () => ({ accounts: [] }),
    '/api/credential-check': () => ({ strict: false }),
    '/ui/api/machines/leftovers': () => ({ ok: true }),
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = String(input).split('?')[0]!;
    calls.push({ method: init.method ?? 'GET', path, ...(init.body ? { body: JSON.parse(String(init.body)) as unknown } : {}) });
    if (path === '/ui/api/session') return json({ authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'admin', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
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

async function boot() {
  calls = [];
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#machines';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', fakeDaemon());
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(document.querySelector('[data-slot="leftovers"]')).not.toBeNull());
}

const leftovers = (): HTMLElement => document.querySelector<HTMLElement>('[data-slot="leftovers"]')!;
const buttonIn = (el: HTMLElement, text: RegExp) => [...el.querySelectorAll('button')].find((b) => text.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('the leftovers on a Machines card (issue #1116)', () => {
  it('lists each leftover with its path, what it is, its size and age, and whether it holds work not pushed or is kept', async () => {
    await boot();
    const text = leftovers().textContent ?? '';
    expect(text).toContain(STRANGER);
    expect(text).toContain('old job files · 2.4 GB · 5 days old');
    expect(text).toContain('work not pushed');
    expect(text).toContain('repository mirror · 340 MB · 9 days old · used by 1 worktree');
    expect(text).toContain('kept');
  });

  it('Keep posts the decision; a kept one offers Remove only', async () => {
    await boot();
    const items = [...leftovers().querySelectorAll('li')];
    expect(buttonIn(items[1]!, /^Keep$/)).toBeUndefined();
    expect(buttonIn(items[1]!, /^Remove$/)).toBeDefined();
    await act(async () => { buttonIn(items[0]!, /^Keep$/)!.click(); });
    await vi.waitFor(() => expect(posts('/ui/api/machines/leftovers')).toEqual([expect.objectContaining({ body: { machineId: 'desk', path: STRANGER, decision: 'keep' } })]));
  });

  it('Remove asks first, saying the work not pushed is lost, then posts the decision', async () => {
    await boot();
    await act(async () => { buttonIn(leftovers().querySelectorAll('li')[0]!, /^Remove$/)!.click(); });
    const dialog = await vi.waitFor(() => { const d = document.querySelector<HTMLElement>('[role="alertdialog"]'); expect(d).not.toBeNull(); return d!; });
    expect(dialog.textContent).toContain('It holds work not pushed: that work is lost.');
    expect(posts('/ui/api/machines/leftovers')).toEqual([]);
    await act(async () => { buttonIn(dialog, /^Remove$/)!.click(); });
    await vi.waitFor(() => expect(posts('/ui/api/machines/leftovers')).toEqual([expect.objectContaining({ body: { machineId: 'desk', path: STRANGER, decision: 'remove' } })]));
  });
});
