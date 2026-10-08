// The Sources view's tests' daemon (test/ui/sources-view.test.ts): a fake of the routes the UI reads, the app
// booted on #sources over it, and its unmount. Test support only.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { vi } from 'vitest';

export const source = (name: string, kind: string, state: string, detail: Record<string, unknown>) =>
  ({ name, kind, state, itemsSeen: 0, jobsCreated: 0, activeJobs: 0, detail });
const SOURCES = [
  source('github-account', 'github-account', 'disabled', { mode: 'account', paused: 'GitHub is not connected: Sources → Connect GitHub' }),
  source('github-app', 'github-app', 'ok', { mode: 'app', slug: 'hopper-app' }),
];

const LOGIN_CODE_SESSION = { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'admin', realm: 'local', name: 'login code' }, signIn: { local: true, origin: 'http://localhost', realms: [] } };
export const GITHUB_SESSION = { ...LOGIN_CODE_SESSION, user: { role: 'admin', realm: 'github', name: 'octo-user', identity: 'octo-user' }, signIn: { ...LOGIN_CODE_SESSION.signIn, devices: [{ name: 'github', label: 'GitHub', type: 'github' }] } };

function fakeDaemon(over: Record<string, unknown> = {}) {
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [], locked: [] },
    '/api/machines': { machines: [] }, '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] },
    '/api/questions': { questions: [] }, '/api/sources': { sources: SOURCES },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
    '/api/connected-accounts': { accounts: [{ provider: 'github', via: 'the hopper\'s app', state: 'not-connected' }] },
    '/ui/api/connected-accounts': { provider: 'github', via: 'the hopper\'s app', state: 'waiting', userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresAt: '2099-01-01T00:00:00.000Z' },
    ...over,
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input).split('?')[0]!;
    // Connecting starts a device code: the daemon's GET answers it from then on.
    if (init?.method === 'POST' && path === '/ui/api/connected-accounts') {
      const accounts = (routes['/api/connected-accounts'] as { accounts: { provider: string }[] }).accounts;
      routes['/api/connected-accounts'] = { accounts: accounts.map((a) => (a.provider === 'github' ? routes[path] : a)) };
    }
    if (path === '/ui/api/session') {
      const s = routes[path] ?? LOGIN_CODE_SESSION;
      return json(200, typeof s === 'function' ? (s as () => unknown)() : s);
    }
    if (path in routes) return json(200, routes[path]);
    return json(404, { error: 'not found' });
  });
}

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

let root: Root | undefined;

export async function boot(over?: Record<string, unknown>) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#sources';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', fakeDaemon(over));
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
}

/** Unmounts the app booted last, and the fakes go. */
export async function unmount(): Promise<void> {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
}
