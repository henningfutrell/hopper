// @vitest-environment happy-dom
// Issue #708, on the page: Vault: a template's form sets its limits, and the template shows them. Issue #1349:
// Add machine adds a computer only: a sandbox never joins as a machine.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const READ = { operation: 'read', asset: { kind: 'cluster', name: 'lab' } };
const KUBE = {
  name: 'kube', image: 'img', secrets: ['KUBE', 'AWS'], profiles: [READ], savedBy: 'Ada', savedAt: '2026-10-11T10:00:00Z',
  approval: { image: 'img', secrets: ['KUBE', 'AWS'], by: 'Ada', at: '' }, pending: { secrets: [], image: false, egress: [], profiles: [] },
  gives: ['KUBE', 'AWS'], radius: { level: 'low', reasons: [], profiles: [] },
  limits: { cpus: { default: 2, max: 4 }, memoryMb: { default: 2048, max: 4096 } },
  tools: ['helm', 'kubectl'],
};
const VIEW = { secrets: [{ id: 's1', name: 'KUBE', setBy: 'Ada', createdAt: '', changedBy: 'Ada', changedAt: '' }], templates: [KUBE], requests: [] };

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
    '/api/sandboxes': { runs: [], problems: [] },
  };
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = String(input).split('?')[0]!;
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ path, method: init.method ?? 'GET', ...(body ? { body } : {}) });
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'admin', realm: 'github', name: 'alice', instanceAdmin: true }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (path === '/ui/api/vault') return json(200, VIEW);
    if (path === '/ui/api/machines/join') return json(200, { code: 'c0de', expiresAt: '2099-01-01T00:00:00.000Z' });
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

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const daemon = fakeDaemon();
  vi.stubGlobal('fetch', daemon.fetch);
  vi.stubGlobal('EventSource', FakeEventSource);
  return daemon;
}

const buttons = (within: ParentNode = document): HTMLButtonElement[] => [...within.querySelectorAll('button')];
const button = (text: string, within: ParentNode = document): HTMLButtonElement => {
  const b = buttons(within).find((x) => x.textContent?.trim() === text);
  if (!b) throw new Error(`no button ${text}: ${buttons(within).map((x) => x.textContent?.trim()).join(' | ')}`);
  return b;
};
const field = (label: string, within: ParentNode = document): HTMLInputElement => {
  const f = within.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!f) throw new Error(`no field ${label}`);
  return f;
};
const click = async (b: HTMLElement) => { await act(async () => { b.click(); }); };

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

describe('Add machine (issue #1349)', () => {
  it('offers no sandbox box: the line is a computer\'s, and nothing starts a box', async () => {
    const daemon = setup();
    vi.resetModules();
    const path = '../../ui/src/views/machine-join.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
    const { JoinMachineForm } = (await import(path)) as { JoinMachineForm: (p: Record<string, unknown>) => ReturnType<typeof createElement> };
    await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(JoinMachineForm, { onDone: () => {}, onSsh: () => {} })); });
    expect(buttons().some((b) => b.textContent?.includes('sandbox'))).toBe(false);
    await click(button('Show the line'));
    await vi.waitFor(() => expect(document.querySelector('code')?.textContent).toContain('/client/install'));
    expect(daemon.calls.find((x) => x.path === '/ui/api/machines/join')!.body).toEqual({});
    expect(daemon.calls.some((x) => x.path.includes('sandbox'))).toBe(false);
  });
});

describe('Vault: a template\'s limits (issue #708)', () => {
  async function boot() {
    const daemon = setup();
    window.location.hash = '#vault';
    vi.resetModules();
    const app = '../../ui/src/app/app.tsx';
    const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
    await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
    await vi.waitFor(() => expect(item()).not.toBeNull());
    return daemon;
  }
  const item = (): HTMLElement | null => [...document.querySelectorAll('li')].find((l) => l.textContent?.includes('Gives now')) ?? null;

  it('the template shows its limits; its form edits them, and Save posts them', async () => {
    const daemon = await boot();
    expect(item()!.textContent).toContain('2 CPUs, at most 4 · 2 GiB, at most 4 GiB');
    expect(item()!.textContent).not.toContain('time limit');
    await click(button('Edit', item()!));
    const form = item()!.querySelector('form')!;
    expect(field('CPUs default', form).value).toBe('2');
    await type(field('CPUs max', form), '6');
    expect(form.querySelector('[aria-label^="Time limit"]')).toBeNull();
    expect(form.querySelector('[aria-label="Keep the home volume when a box goes"]')).toBeNull();
    await click(button('Save template', form));
    await vi.waitFor(() => expect(daemon.calls.find((x) => x.path === '/ui/api/vault')).toBeDefined());
    const body = daemon.calls.find((x) => x.path === '/ui/api/vault')!.body!;
    expect(body).toMatchObject({ action: 'save-template', name: 'kube' });
    expect(body.limits).toEqual({ cpus: { default: 2, max: 6 }, memoryMb: { default: 2048, max: 4096 } });
  });

  it('limits it cannot take: says why, and Save waits', async () => {
    await boot();
    await click(button('Edit', item()!));
    const form = item()!.querySelector('form')!;
    await type(field('CPUs max', form), '');
    expect(form.querySelector('[data-limits-problem]')!.textContent).toBe('CPUs: give the default and the max, or neither');
    expect(button('Save template', form).disabled).toBe(true);
  });
});
