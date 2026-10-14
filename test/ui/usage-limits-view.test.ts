// @vitest-environment happy-dom
// The usage limits on the Usage view (issue #522), rendered inside the whole app against a fake of the daemon's HTTP
// surface: usage now, its band and each machine's lane cap; the graph with a handle per limit. An admin moves a limit
// (a handle's arrow keys, or the number fields) and sees the band and the lane caps follow before saving; a soft limit
// at or above the hard one is refused in place, and nothing is posted; Save posts the limits. A viewer reads only.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Role = 'viewer' | 'admin';
const limits = { soft: 0.7, hard: 0.95, defaults: { soft: 0.7, hard: 0.95 }, set: false };
const usage = {
  readings: [{ source: 'plan', window: 'session', used: 60, limit: 100, unit: '%', at: '2026-10-08T12:00:00.000Z' }],
  sources: [{ name: 'plan' }], limits,
  machines: [{ machineId: 'desk', label: 'desk', online: true, maxLanes: 4, usedFrac: 0.6, cap: 4, band: 'free', executors: [] }],
};
const history = {
  view: { range: { preset: '24h' } }, from: '2026-10-07T12:00:00.000Z', to: '2026-10-08T12:00:00.000Z', stepMs: 3_600_000, retentionDays: 90,
  series: [{ account: 'a', window: 'session', informational: false, unit: '%', gaps: [], resets: [], points: [{ at: '2026-10-08T10:00:00.000Z', usedFrac: 0.5 }] }],
};

function fakeDaemon(role: Role) {
  const posts: { path: string; body: unknown }[] = [];
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [], locked: [] },
    '/api/machines': { machines: [] }, '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] }, '/api/sources': { sources: [] },
    '/api/questions': { questions: [] }, '/api/accounts': { accounts: [] }, '/api/usage': usage, '/api/usage/history': history,
    '/api/logins': { now: '2026-10-08T12:00:00.000Z', settings: { onExpiry: 'fail', warnSec: 60 }, logins: [] },
    // The resource graphs (issue #560): no machine samples.
    '/api/machines/history': { view: { range: { preset: '24h' } }, from: '2026-10-08T00:00:00.000Z', to: '2026-10-09T00:00:00.000Z', stepMs: 900000, retentionDays: 90, series: [] },
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

/** Every observed element is 640 × 220: the graph draws at a width. */
class SizedResizeObserver {
  private readonly fn: (entries: { contentRect: { width: number; height: number } }[]) => void;
  constructor(fn: (entries: { contentRect: { width: number; height: number } }[]) => void) { this.fn = fn; }
  observe(): void { this.fn([{ contentRect: { width: 640, height: 220 } }]); }
  disconnect(): void {}
  unobserve(): void {}
}

let root: Root | undefined;
let daemon: ReturnType<typeof fakeDaemon>;

async function boot(role: Role) {
  window.location.hash = '#usage';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  daemon = fakeDaemon(role);
  vi.stubGlobal('fetch', daemon.fetch);
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('ResizeObserver', SizedResizeObserver);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx';
  const mod = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(mod.App)); });
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const slider = (name: string) => document.querySelector<SVGGElement>(`[role="slider"][aria-label="${name} limit"]`)!;
const saveButton = () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Save') as HTMLButtonElement | undefined;
const text = (slot: string) => document.querySelector(`[data-slot="${slot}"]`)?.textContent;
const cap = () => document.querySelector('[data-machine-cap="desk"]')?.textContent;
function type(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('the usage limits on the Usage view', () => {
  it('usage now, its band and the lane cap; the graph with a handle per limit', async () => {
    await boot('admin');
    expect(text('usage-now-value')).toBe('60%');
    expect(text('usage-band')).toBe('free: every lane open');
    expect(cap()).toContain('4/4 lanes');
    expect(slider('Soft').getAttribute('aria-valuenow')).toBe('70');
    expect(slider('Hard').getAttribute('aria-valuenow')).toBe('95');
    expect(input('usage-soft-limit').value).toBe('70');
    expect(saveButton()!.disabled).toBe(true);
  });

  it('moving a limit moves the band and the lane cap before saving; Save posts the limits', async () => {
    await boot('admin');
    await act(async () => { type(input('usage-soft-limit'), '50'); });
    expect(text('usage-band')).toBe('soft: lanes scale down');
    expect(cap()).toMatch(/4\s*3\/4 lanes/);
    // A handle's arrow keys: the hard limit down by 5% at a time.
    await act(async () => { slider('Hard').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true })); });
    expect(input('usage-hard-limit').value).toBe('90');
    await act(async () => { saveButton()!.click(); });
    expect(daemon.posts).toEqual([{ path: '/ui/api/usage/limits', body: { soft: 0.5, hard: 0.9 } }]);
  });

  it('a soft limit at or above the hard one is refused in place: Save stays off, nothing is posted', async () => {
    await boot('admin');
    await act(async () => { type(input('usage-soft-limit'), '95'); });
    expect(text('usage-limits-problem')).toBe('The soft limit must be below the hard limit.');
    expect(saveButton()!.disabled).toBe(true);
    await act(async () => { saveButton()!.closest('form')!.requestSubmit(); });
    expect(daemon.posts).toEqual([]);
  });

  it('a viewer reads the limits: no handles to move, no fields to edit, no Save', async () => {
    await boot('viewer');
    expect(document.querySelector('[role="slider"]')).toBeNull();
    expect(document.querySelectorAll('[data-limit]')).toHaveLength(2);
    expect(input('usage-soft-limit').disabled).toBe(true);
    expect(saveButton()).toBeUndefined();
  });
});
