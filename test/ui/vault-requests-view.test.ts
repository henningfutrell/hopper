// @vitest-environment happy-dom
// Settings → Vault, "Asked for" (issue #583), rendered in happy-dom inside the whole app against a fake of the daemon's
// HTTP surface: a credential request a job on a box opened shows who waits and why, how to get the credential, and the
// kinds the skill takes, the suggested one first; the value is a password field; Give posts the kind, the name and the
// value; something else needs the person's words first; Decline posts the reason.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const REQUEST = {
  id: 'r1', skill: 'render', title: 'render', known: true, template: 'web', secret: 'render',
  kinds: [{ id: 'api-key', title: 'A Render API key' }, { id: 'deploy-hook', title: 'A deploy hook URL of one service' }],
  setup: 'In the Render dashboard: Account Settings → API Keys → Create API Key.',
  asked: [{ job: 'f3b1c2d4-0000-4000-8000-000000000001', machine: 'hopper-sandbox-web', why: 'deploy the web service', at: '2026-10-09T12:00:00.000Z' }],
  existing: [], createdAt: '2026-10-09T12:00:00.000Z',
};
const VIEW = { secrets: [], templates: [], requests: [REQUEST] };

interface Call { path: string; method: string; body?: Record<string, unknown> }

function fakeDaemon() {
  const calls: Call[] = [];
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [], locked: [] },
    '/api/machines': { machines: [] }, '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] }, '/api/questions': { questions: [] },
    '/api/sources': { sources: [] }, '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
    '/api/vault': VIEW,
  };
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = String(input).split('?')[0]!;
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ path, method: init.method ?? 'GET', ...(body ? { body } : {}) });
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'admin', realm: 'github', name: 'alice', instanceAdmin: true }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (path === '/ui/api/vault') return json(200, { ...VIEW, requests: [] });
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

async function boot() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#settings/vault';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const daemon = fakeDaemon();
  vi.stubGlobal('fetch', daemon.fetch);
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(card()).not.toBeNull());
  return daemon;
}

const card = (): HTMLElement | null => [...document.querySelectorAll('li')].find((l) => l.textContent?.includes('Waits: job')) ?? null;
const button = (text: string): HTMLButtonElement => [...card()!.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)! as HTMLButtonElement;

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('Settings → Vault: a credential a job asked for (issue #583)', () => {
  it('shows who waits and why, how to get one, and the kinds, the suggested first; Give posts the kind, name and value', async () => {
    const daemon = await boot();
    const c = card()!;
    expect(c.textContent).toContain('render');
    expect(c.textContent).toContain('for boxes of web');
    expect(c.textContent).toContain('Waits: job f3b1c2d4 on hopper-sandbox-web: deploy the web service');
    expect(c.textContent).toContain('How to get one: In the Render dashboard: Account Settings → API Keys');
    const kinds = [...c.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(kinds.map((k) => k.parentElement!.textContent)).toEqual(['A Render API key', 'A deploy hook URL of one service', 'Something else — say what it is']);
    expect(kinds[0]!.checked).toBe(true);
    const value = c.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(value.autocomplete).toBe('new-password');
    expect(button('Give').disabled).toBe(true);

    await type(value, 'rnd_key');
    await act(async () => { button('Give').click(); });
    await vi.waitFor(() => expect(daemon.calls.find((x) => x.path === '/ui/api/vault')).toBeDefined());
    expect(daemon.calls.find((x) => x.path === '/ui/api/vault')!.body).toEqual({ action: 'give-credential', request: 'r1', name: 'render', kind: 'api-key', value: 'rnd_key' });
  });

  it('something else needs the person\'s words before Give; Decline posts the reason', async () => {
    const daemon = await boot();
    await act(async () => { card()!.querySelectorAll<HTMLInputElement>('input[type="radio"]')[2]!.click(); });
    await type(card()!.querySelector<HTMLInputElement>('input[type="password"]')!, 'rnd_key');
    expect(button('Give').disabled).toBe(true);
    await type(card()!.querySelector<HTMLInputElement>('input[placeholder="a team key, read-only"]')!, 'a team key');
    expect(button('Give').disabled).toBe(false);

    await type(card()!.querySelector<HTMLInputElement>('input[aria-label="Why not"]')!, 'deploy by hand');
    await act(async () => { button('Decline').click(); });
    await vi.waitFor(() => expect(daemon.calls.find((x) => x.path === '/ui/api/vault')).toBeDefined());
    expect(daemon.calls.find((x) => x.path === '/ui/api/vault')!.body).toEqual({ action: 'decline-credential', request: 'r1', reason: 'deploy by hand' });
  });
});
