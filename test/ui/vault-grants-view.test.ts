// @vitest-environment happy-dom
// Access requests (issue #897; Vault until then), "Vault grants" (issue #652, requirement 5), rendered in happy-dom inside the whole app against a fake
// of the daemon's HTTP surface: a job on a box that asked the vault with no grant shows as a card — the job, its box and
// template, what it asked for — with "Grant this job the vault"; Grant posts the job's grant. A granted job's item shows
// who granted it, and Revoke takes the grant back.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const JOB = 'f3b1c2d4-0000-4000-8000-000000000001';
const ASK = { job: JOB, key: 'https://github.com/octo-org/hello/issues/7', machine: 'hopper-sandbox-web', template: 'web', names: ['KUBE_TOKEN'], askedAt: '2026-10-11T12:00:00.000Z' };
const GRANT = {
  key: 'https://github.com/octo-org/hello/issues/9', job: 'a1b2c3d4-0000-4000-8000-000000000002', by: 'alice', at: '2026-10-11T11:00:00.000Z', made: 'grant',
  item: { title: 'Fix the login', repo: 'octo-org/hello', url: 'https://github.com/octo-org/hello/issues/9', job: 'a1b2c3d4-0000-4000-8000-000000000002', status: 'running', stale: false },
};
// Issue #1124: a direct job's grant, made by the operator CLI at submit, whose job ended: stale.
const STALE = {
  key: 'direct:5e6f7a8b-0000-4000-8000-000000000003', job: 'c1d2e3f4-0000-4000-8000-000000000004', by: 'operator CLI', at: '2026-10-10T09:00:00.000Z',
  made: 'submit', via: 'cli', command: 'hopper job submit --authorize vault',
  item: { title: 'Rotate the lab key', job: 'c1d2e3f4-0000-4000-8000-000000000004', status: 'finished', stale: true },
};
const VIEW = { secrets: [], templates: [], grantAsks: [ASK], grants: [GRANT, STALE] };

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
    if (path === `/ui/api/jobs/${JOB}/grant-vault`) return json(200, { ...VIEW, grantAsks: [], grants: [GRANT, { key: ASK.key, job: JOB, by: 'alice', at: '2026-10-11T12:01:00.000Z', made: 'grant', item: { title: 'Add the cluster check', url: ASK.key, job: JOB, status: 'running', stale: false } }] });
    if (path === `/ui/api/jobs/${GRANT.job}/revoke-vault`) return json(200, { ...VIEW, grants: [STALE] });
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
  window.location.hash = '#access-requests';
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

const card = (): HTMLElement | null => [...document.querySelectorAll('li')].find((l) => l.textContent?.includes('Grant this job the vault')) ?? null;
const grantRow = (): HTMLElement | null => [...document.querySelectorAll('li')].find((l) => l.textContent?.includes('Fix the login')) ?? null;
const staleRow = (): HTMLElement | null => [...document.querySelectorAll('li')].find((l) => l.textContent?.includes('Rotate the lab key')) ?? null;
const button = (text: string): HTMLButtonElement => [...card()!.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)! as HTMLButtonElement;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('Access requests: a job that asks for the vault (issue #652)', () => {
  it('shows the job, its box and what it asked for; Grant posts the job\'s grant', async () => {
    const daemon = await boot();
    const c = card()!;
    expect(c.textContent).toContain('job f3b1c2d4');
    expect(c.textContent).toContain('on hopper-sandbox-web, a box of web');
    expect(c.textContent).toContain('KUBE_TOKEN');
    expect(c.textContent).toContain('https://github.com/octo-org/hello/issues/7');
    await act(async () => { button('Grant').click(); });
    await vi.waitFor(() => expect(daemon.calls.find((x) => x.path.endsWith('/grant-vault'))).toBeDefined());
    expect(daemon.calls.find((x) => x.path.endsWith('/grant-vault'))).toMatchObject({ path: `/ui/api/jobs/${JOB}/grant-vault`, method: 'POST' });
    await vi.waitFor(() => expect(card()).toBeNull());
  });

  it('a granted item says who granted it; Revoke takes the grant back', async () => {
    const daemon = await boot();
    const row = grantRow()!;
    expect(row.textContent).toContain('granted by alice');
    await act(async () => { [...row.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Revoke')!.click(); });
    await vi.waitFor(() => expect(daemon.calls.find((x) => x.path.endsWith('/revoke-vault'))).toMatchObject({ path: `/ui/api/jobs/${GRANT.job}/revoke-vault`, method: 'POST' }));
    await vi.waitFor(() => expect(grantRow()).toBeNull());
  });

  it('a grant names its item — title, repository, link —, its job\'s status and the date granted (issue #1124)', async () => {
    await boot();
    const row = grantRow()!;
    expect(row.textContent).toContain('octo-org/hello');
    expect(row.querySelector('a')?.getAttribute('href')).toBe('https://github.com/octo-org/hello/issues/9');
    expect(row.textContent).toContain('running');
    expect(row.textContent).toContain('2026-10-11');
    expect(row.textContent).not.toContain('Stale');
    expect(row.textContent).not.toContain('direct:');
  });

  it('a grant whose item has no job at work is flagged stale, with Revoke; one the operator CLI made names its command (issue #1124)', async () => {
    const daemon = await boot();
    const row = staleRow()!;
    expect(row.textContent).toContain('Stale');
    expect(row.textContent).toContain('finished');
    expect(row.textContent).toContain('operator CLI');
    expect(row.textContent).toContain('hopper job submit --authorize vault');
    expect(row.textContent).not.toContain('5e6f7a8b');
    await act(async () => { [...row.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Revoke')!.click(); });
    await vi.waitFor(() => expect(daemon.calls.find((x) => x.path.endsWith('/revoke-vault'))).toMatchObject({ path: `/ui/api/jobs/${STALE.job}/revoke-vault` }));
  });
});
