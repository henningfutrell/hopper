// @vitest-environment happy-dom
// Issue #2352: the Machines page's Cards / List toggle and its collapsible sections, rendered inside the whole app against a
// fake of the daemon's HTTP surface. List shows one row per machine with no card chrome; a click on a row expands it to the
// machine's card with every action the card has; the mode and the collapsed sections are kept in browser storage, so a
// reload restores them.
//
// Feature: the Machines list view
//   Scenario: the page starts in Cards; List shows one row per machine, and a reload keeps List
//   Scenario: a row expands to its card, with Terminal, Drain, Edit and Remove
//   Scenario: a row with an alert shows the warning marker
//   Scenario: a section collapses, and a reload keeps it collapsed
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const machine = (id: string, o: Record<string, unknown> = {}) => ({ id, label: id, maxLanes: 2, online: true, executors: ['herdr-claude'], usage: [], lanes: [], herdr: { session: 'hopper' }, ...o });
const SIX = ['desk', 'lab', 'nas', 'pi', 'tower', 'mini'].map((id) => machine(id));

let MACHINES: unknown[] = [];

const button = (text: RegExp) => [...document.querySelectorAll('button')].find((b) => text.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-slot="machine-row"]')];
const cards = () => document.querySelector('[data-slot="machine-cards"]');
const section = (id: string) => document.querySelector<HTMLElement>(`[data-slot="machines-section"][data-section="${id}"]`)!;

function fakeDaemon() {
  const routes: Record<string, () => unknown> = {
    '/api/health': () => ({ ok: true, version: '0', router: 'pass-through', fallback: false, executors: ['herdr-claude'], uptimeS: 1 }),
    '/api/queue': () => ({ waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], waitingOn: [], ended: [], locked: [] }),
    '/api/machines': () => ({ machines: MACHINES }), '/api/decisions': () => ({ decisions: [] }), '/api/events': () => ({ events: [] }),
    '/api/webhooks': () => ({ subscriptions: [] }), '/api/webhooks/deliveries': () => ({ deliveries: [] }),
    '/api/questions': () => ({ questions: [] }), '/api/sources': () => ({ sources: [] }),
    '/api/usage': () => ({ readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }), '/api/accounts': () => ({ accounts: [] }),
    '/api/credential-check': () => ({ strict: false }),
    '/api/sandboxes': () => ({ launch: { available: true }, problems: [] }),
    '/api/machines/config': () => ({
      version: 'v1', executors: ['herdr-claude'], defaults: { lanes: 2, executors: ['herdr-claude'] }, ssh: { targets: [], notes: [], here: [] },
      machines: SIX.map((m) => ({ name: m.id, plugin: 'local', connection: 'local', options: { lanes: 2 } })),
    }),
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string) => {
    const path = String(input).split('?')[0]!;
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

/** Starts the app on Machines; `reload` keeps browser storage, as a reload of the page does. */
async function boot(machines: unknown[], { reload = false } = {}) {
  MACHINES = machines;
  act(() => root?.unmount());
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#machines';
  if (!reload) localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', fakeDaemon());
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(section('machines')).not.toBeNull());
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('the Machines list view (issue #2352)', () => {
  it('starts in Cards; List shows one row per machine, and a reload keeps List', async () => {
    await boot(SIX);
    await vi.waitFor(() => expect(cards()).not.toBeNull());
    expect(document.querySelector('[data-slot="machines-mode-cards"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(rows()).toHaveLength(0);

    await act(async () => { document.querySelector<HTMLButtonElement>('[data-slot="machines-mode-list"]')!.click(); });
    expect(cards()).toBeNull();
    expect(rows().map((r) => r.dataset.machine)).toEqual(SIX.map((m) => m.id));
    expect(rows()[0]!.textContent).toContain('lanes 0/2');
    expect(localStorage.getItem('jh_machines_mode')).toBe('list');

    await boot(SIX, { reload: true });
    await vi.waitFor(() => expect(rows()).toHaveLength(6));
    expect(cards()).toBeNull();
    expect(document.querySelector('[data-slot="machines-mode-list"]')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('a row expands to its card, with Terminal, Drain, Edit and Remove', async () => {
    await boot(SIX);
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-slot="machines-mode-list"]')!.click(); });
    expect(button(/^Edit$/)).toBeUndefined();
    const desk = rows()[0]!;
    await act(async () => { desk.querySelector('button')!.click(); });
    expect(desk.dataset.open).toBe('');
    await vi.waitFor(() => expect(desk.querySelector('[aria-label="Edit desk"]')).not.toBeNull());
    expect(desk.querySelector('[aria-label="Remove desk"]')).not.toBeNull();
    const labels = [...desk.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).toEqual(expect.arrayContaining(['Terminal', 'Drain', 'Resources, lanes and usage']));
    expect(rows()[1]!.dataset.open).toBeUndefined();

    await act(async () => { desk.querySelector('button')!.click(); });
    expect(desk.dataset.open).toBeUndefined();
    expect(desk.querySelector('[aria-label="Edit desk"]')).toBeNull();
  });

  it('a row with an alert shows the warning marker', async () => {
    await boot([machine('desk', { disk: { freeBytes: 1, totalBytes: 100, low: true } }), machine('lab')]);
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-slot="machines-mode-list"]')!.click(); });
    expect(rows()[0]!.querySelector('[data-slot="machine-row-alert"]')).not.toBeNull();
    expect(rows()[1]!.querySelector('[data-slot="machine-row-alert"]')).toBeNull();
  });

  it('a section collapses, and a reload keeps it collapsed', async () => {
    await boot(SIX);
    await vi.waitFor(() => expect(cards()).not.toBeNull());
    const toggle = () => section('machines').querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    await act(async () => { toggle().click(); });
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(cards()).toBeNull();
    expect(document.querySelector('[data-slot="machines-mode-list"]')).toBeNull();

    await boot(SIX, { reload: true });
    expect(section('machines').dataset.open).toBeUndefined();
    expect(cards()).toBeNull();
    await act(async () => { toggle().click(); });
    await vi.waitFor(() => expect(cards()).not.toBeNull());
    expect(JSON.parse(localStorage.getItem('jh_machines_collapsed')!)).toEqual([]);
  });
});
