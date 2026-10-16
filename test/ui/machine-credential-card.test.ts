// @vitest-environment happy-dom
// Issue #1467: the credential check on the Machines view, rendered inside the whole app against a fake of the daemon's
// HTTP surface. Each card shows one state, the one the daemon's `credentialHeld` (the decider's own rule) says: a machine
// taking jobs never says it is not ready or that its jobs wait for another machine; a held one says why, with the fix and
// Use anyway. Acknowledge and Stop taking jobs post the machine's credential routes.
//
// Feature: the credential card
//   Scenario: a machine with credentials takes jobs with a warning, and an admin acknowledges it
//   Scenario: an acknowledged machine takes jobs with its warning folded
//   Scenario: a held machine says why, with the fix and Use anyway
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const T = '2026-10-16T12:00:00.000Z';
const machine = (id: string, extra: Record<string, unknown>) => ({ id, label: id, maxLanes: 2, online: true, executors: ['herdr-claude'], lanes: [], usage: [], infraCredentials: ['.kube', '.config/gh/hosts.yml'], ...extra });
const MACHINES = [
  machine('fresh', {}),
  machine('seen', { credentialAcceptance: { machineKey: 'seen', credentials: ['.kube', '.config/gh/hosts.yml'], acceptedBy: 'u1', acceptedAt: T } }),
  machine('strict', { credentialHeld: true }),
];
const CONTRADICTS = /not ready|takes no new job|wait for another machine|not taking jobs|takes jobs despite/i;

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
    '/ui/api/machines/fresh/credentials/accept': () => ({ ok: true }), '/ui/api/machines/fresh/credentials/revoke': () => ({ ok: true }),
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
  await vi.waitFor(() => expect(document.querySelectorAll('[data-slot="infra-credentials"]')).toHaveLength(3));
}

/** A machine's credential part: the cards render in the daemon's order, one part each. */
const cardOf = (id: string): HTMLElement => [...document.querySelectorAll<HTMLElement>('[data-slot="infra-credentials"]')][MACHINES.findIndex((m) => m.id === id)]!;
const buttonIn = (el: HTMLElement, text: RegExp) => [...el.querySelectorAll('button')].find((b) => text.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('the credential card on the Machines view (issue #1467)', () => {
  it('a machine with credentials takes jobs with a warning; Acknowledge and Stop taking jobs post its routes', async () => {
    await boot();
    const card = cardOf('fresh');
    expect(card.dataset.state).toBe('warning');
    expect(card.querySelector('[data-slot="credential-headline"]')?.textContent).toBe('Taking jobs');
    expect(card.textContent).toContain('Its job user holds credentials a job could use: .kube, .config/gh/hosts.yml.');
    expect(card.textContent).not.toMatch(CONTRADICTS);
    expect(card.querySelector('details')?.open).toBe(false);
    expect(buttonIn(card, /^Use anyway$/)).toBeUndefined();
    await act(async () => { buttonIn(card, /^Acknowledge$/)!.click(); });
    await vi.waitFor(() => expect(posts('/ui/api/machines/fresh/credentials/accept')).toEqual([expect.objectContaining({ body: { machineKey: 'fresh', credentials: ['.kube', '.config/gh/hosts.yml'] } })]));
    await act(async () => { buttonIn(cardOf('fresh'), /^Stop taking jobs$/)!.click(); });
    await vi.waitFor(() => expect(posts('/ui/api/machines/fresh/credentials/revoke')).toHaveLength(1));
  });

  it('an acknowledged machine takes jobs, its warning folded and no Acknowledge', async () => {
    await boot();
    const card = cardOf('seen');
    expect(card.dataset.state).toBe('acknowledged');
    expect(card.querySelector('[data-slot="credential-headline"]')?.textContent).toBe('Taking jobs');
    expect(card.textContent).not.toMatch(CONTRADICTS);
    expect(buttonIn(card, /^Acknowledge$/)).toBeUndefined();
    expect(buttonIn(card, /^Stop taking jobs$/)).toBeDefined();
  });

  it('a held machine says why, with the fix up front and Use anyway', async () => {
    await boot();
    const card = cardOf('strict');
    expect(card.dataset.state).toBe('held');
    expect(card.querySelector('[data-slot="credential-headline"]')?.textContent).toBe('Not taking jobs');
    expect(card.textContent).toContain('Strict mode is on');
    expect(card.querySelector('details')).toBeNull();
    expect(card.querySelector('[data-slot="job-user-commands"]')).not.toBeNull();
    expect(card.textContent).not.toMatch(/takes jobs despite|Taking jobs/);
    expect(buttonIn(card, /^Use anyway$/)).toBeDefined();
    expect(buttonIn(card, /^Stop taking jobs$/)).toBeUndefined();
  });
});
