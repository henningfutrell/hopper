// @vitest-environment happy-dom
// The Job rules section of Settings (issue #172), rendered in happy-dom inside the whole app against a fake
// of the daemon's HTTP surface: the job rules every job's prompt carries, edited whole through
// POST /ui/api/job-rules with the version the draft was based on, the default one click away, and the
// fixed lines — the work tree and the protocol the hopper reads back — shown but not editable.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const DEFAULT = '[hopper publishing rule] Neutral text only.\n[hopper parallel work] Other jobs run too.';
const FIXED = ["[hopper work tree] This job's work tree is <work tree>.", '[hopper protocol] … HOPPER_QUESTION', 'If the job cannot be done, … HOPPER_FAILED followed by the reason.'];
const VIEW = { text: 'Be brief.\n', version: 'v1', missing: false, default: DEFAULT, fixed: FIXED };

interface Call { path: string; method: string; headers: Record<string, string>; body?: Record<string, unknown> }

function fakeDaemon(view: typeof VIEW) {
  const calls: Call[] = [];
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [], locked: [] },
    '/api/machines': { machines: [] },
    '/api/decisions': { decisions: [] },
    '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] },
    '/api/webhooks/deliveries': { deliveries: [] },
    '/api/questions': { questions: [] },
    '/api/sources': { sources: [] },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] },
    '/api/accounts': { accounts: [] },
    '/api/job-rules': view,
  };
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = String(input).split('?')[0]!;
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ path, method: init.method ?? 'GET', headers, ...(body ? { body } : {}) });
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'admin', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (path === '/ui/api/job-rules') return json(200, { ...view, text: body!.text, version: 'v2', missing: false });
    if (path in routes) return json(200, routes[path]);
    return json(404, { error: 'not found' });
  });
  return { fetch, calls };
}

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

let root: Root | undefined;

async function boot(view = VIEW) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#settings/job-rules';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const daemon = fakeDaemon(view);
  vi.stubGlobal('fetch', daemon.fetch);
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(box()).not.toBeNull());
  return daemon;
}

const panel = () => document.querySelector('[data-slot="job-rules"]');
const box = () => panel()?.querySelector<HTMLTextAreaElement>('textarea[name="job-rules"]') ?? null;
const button = (label: string) => [...panel()!.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
const click = (b: HTMLElement | undefined) => act(async () => { b!.click(); });
const type = (el: HTMLTextAreaElement, text: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('job rules section', () => {
  it('is a section of Settings, with the job rules editable and the fixed lines shown read-only', async () => {
    await boot();
    expect(document.querySelector('[data-slot="settings-nav"] a[href="#settings/job-rules"]')?.textContent).toBe('Job rules');
    expect(box()!.value).toBe('Be brief.\n');
    expect(box()!.readOnly).toBe(false);
    const fixed = panel()!.querySelector('[data-slot="fixed-job-lines"]')!;
    for (const line of FIXED) expect(fixed.textContent).toContain(line);
    expect(fixed.querySelector('textarea, input')).toBeNull();
  });

  it('Save posts the draft with the version it was based on', async () => {
    const daemon = await boot();
    await type(box()!, 'Never touch main.\n');
    await click(button('Save job rules'));
    await vi.waitFor(() => expect(daemon.calls.some((c) => c.path === '/ui/api/job-rules')).toBe(true));
    const call = daemon.calls.find((c) => c.path === '/ui/api/job-rules')!;
    expect(call.method).toBe('POST');
    expect(call.body).toEqual({ text: 'Never touch main.\n', version: 'v1' });
  });

  it('Use the default puts the default text in the draft, to save', async () => {
    const daemon = await boot();
    await click(button('Use the default'));
    expect(box()!.value).toBe(DEFAULT);
    await click(button('Save job rules'));
    await vi.waitFor(() => expect(daemon.calls.find((c) => c.path === '/ui/api/job-rules')?.body).toEqual({ text: DEFAULT, version: 'v1' }));
  });

  it('while none are saved it shows the default and says so; there is nothing to reset', async () => {
    await boot({ ...VIEW, text: DEFAULT, version: 'missing', missing: true });
    expect(box()!.value).toBe(DEFAULT);
    expect(panel()!.textContent).toContain('the default');
    expect(button('Use the default')).toBeUndefined();
  });
});
