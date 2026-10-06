// @vitest-environment happy-dom
// The Sources view (issue #160) rendered in the whole app against a fake of the daemon's HTTP surface:
// gh and the GitHub App are one GitHub section, the one in use first, the paused one saying why, and
// gh login beside them under its own name.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const source = (name: string, kind: string, state: string, detail: Record<string, unknown>) =>
  ({ name, kind, state, itemsSeen: 0, jobsCreated: 0, activeJobs: 0, detail });
const SOURCES = [
  source('github', 'github', 'disabled', { mode: 'gh', enabledSetting: 'auto', paused: 'GitHub App configured' }),
  source('github-app', 'github-app', 'ok', { mode: 'app', slug: 'hopper-app' }),
];

function fakeDaemon() {
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', routerMode: 'shadow', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], waitingAnswer: [], ended: [] },
    '/api/machines': { machines: [] }, '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] },
    '/api/questions': { questions: [] }, '/api/sources': { sources: SOURCES },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
    '/api/gh-login': { state: 'logged-in', account: 'someone' },
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string) => {
    const path = String(input).split('?')[0]!;
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'admin', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
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

async function boot() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#sources';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', fakeDaemon());
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

const titles = () => [...document.querySelectorAll('[aria-labelledby="sources-github"] h2')].map((h) => h.textContent);

describe('Sources view: GitHub', () => {
  it('one GitHub section: the App in use first, gh paused with the reason, gh login last', async () => {
    await boot();
    await vi.waitFor(() => expect(titles()).toEqual(['GitHub', 'github-app', 'github', 'gh login']));
    expect(document.querySelector('[data-github-summary]')?.textContent).toContain('Issues are read through the GitHub App, as its bot. gh is paused while the GitHub App is set up.');
    const uses = [...document.querySelectorAll('[data-source-use]')].map((e) => [e.getAttribute('data-source-use'), e.textContent]);
    expect(uses).toEqual([
      ['in-use', 'through the GitHub App, as its bot'],
      ['paused', 'through gh, as the logged-in GitHub user · not in use: the GitHub App is set up, so issues are read through it instead'],
    ]);
    expect(document.body.textContent).not.toContain('paused: GitHub App configured');
    expect(document.body.textContent).not.toContain('GitHub (gh)');
  });
});
