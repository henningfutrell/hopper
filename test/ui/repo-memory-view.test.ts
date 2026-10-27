// @vitest-environment happy-dom
// Settings → Repository memory (issue #2847, design.md "Repository memory"), rendered in happy-dom inside the whole app
// against a fake of the daemon's HTTP surface: each memory entry with its kind, state, area and source job; Approve, Edit,
// Disable and Remove post their act to POST /ui/api/repo-memory and the view reads the entries again; the repository
// filter; the settings saved against the version read. A reader sees the entries and no act.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const JOB = 'de987f4a-0000-4000-8000-000000000001';
const at = '2026-10-20T12:00:00.000Z';
const PROPOSED = { id: 'aaaa1111-0000-4000-8000-000000000001', shortId: 'aaaa1111', repo: 'acme/app', kind: 'convention', area: 'src/store', text: 'Run npm test -- <file>.', state: 'proposed', confidence: 0.5, sourceJobId: JOB, createdAt: at, updatedAt: at, by: `job ${JOB}`, expired: false };
const APPROVED = { id: 'bbbb2222-0000-4000-8000-000000000002', shortId: 'bbbb2222', repo: 'acme/lib', kind: 'fix', text: 'The build needs Node 24.', state: 'approved', confidence: 1, createdAt: at, updatedAt: at, by: 'alice', expired: false };
const SETTINGS = { on: true, approval: true, maxBytes: 4096, expireDays: 180, repos: {} };

interface Call { path: string; method: string; body?: Record<string, unknown> }

function fakeDaemon(role: string) {
  const calls: Call[] = [];
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [], locked: [] },
    '/api/machines': { machines: [] }, '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] }, '/api/questions': { questions: [] },
    '/api/sources': { sources: [] }, '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
    '/api/repo-memory': { entries: [PROPOSED, APPROVED], settings: SETTINGS, version: 'v1' },
  };
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = String(input).split('?')[0]!;
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ path, method: init.method ?? 'GET', ...(body ? { body } : {}) });
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role, realm: 'github', name: 'alice', instanceAdmin: role === 'admin' }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (path === '/ui/api/repo-memory') return json(200, body?.action === 'remove' ? { removed: true } : { entry: PROPOSED });
    if (path === '/ui/api/repo-memory/settings') return json(200, { settings: SETTINGS, version: 'v2' });
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

async function boot(role = 'admin') {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#settings/repo-memory';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const daemon = fakeDaemon(role);
  vi.stubGlobal('fetch', daemon.fetch);
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(entry('aaaa1111')).not.toBeNull());
  return daemon;
}

const entry = (short: string): HTMLElement | null => document.querySelector(`[data-entry="${short}"]`);
const button = (in_: ParentNode, text: string): HTMLButtonElement | undefined => [...in_.querySelectorAll('button')].find((b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text);
const setValue = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const posts = (calls: Call[]) => calls.filter((c) => c.path === '/ui/api/repo-memory' && c.method === 'POST').map((c) => c.body);
const reads = (calls: Call[]) => calls.filter((c) => c.path === '/api/repo-memory').length;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('Settings: repository memory (issue #2847)', () => {
  it('shows each entry, its kind, state, area and the job that learned it', async () => {
    await boot();
    const p = entry('aaaa1111')!;
    expect(p.textContent).toContain('Run npm test -- <file>.');
    expect(p.textContent).toContain('Waits for approval');
    expect(p.textContent).toContain('src/store');
    expect(p.querySelector(`a[href="#job/${JOB}"]`)).not.toBeNull();
    const a = entry('bbbb2222')!;
    expect(a.textContent).toContain('Past fix');
    expect(a.textContent).toContain('added by a person');
    expect(button(p, 'Approve')).toBeDefined();
    expect(button(a, 'Approve')).toBeUndefined();
    expect(document.querySelector('[data-slot="repo-memory-summary"]')!.textContent).toContain('waits for a person\'s approval');
  });

  it('Approve, Disable, an edit and Remove each post their act; the view reads the entries again', async () => {
    const daemon = await boot();
    const before = reads(daemon.calls);
    await act(async () => { button(entry('aaaa1111')!, 'Approve')!.click(); });
    await vi.waitFor(() => expect(posts(daemon.calls)).toContainEqual({ action: 'approve', id: PROPOSED.id }));
    await vi.waitFor(() => expect(reads(daemon.calls)).toBeGreaterThan(before));
    await act(async () => { button(entry('bbbb2222')!, 'Disable')!.click(); });
    await vi.waitFor(() => expect(posts(daemon.calls)).toContainEqual({ action: 'disable', id: APPROVED.id }));

    await vi.waitFor(() => expect(button(entry('bbbb2222')!, 'Edit')?.disabled).toBe(false));
    await act(async () => { button(entry('bbbb2222')!, 'Edit')!.click(); });
    const text = entry('bbbb2222')!.querySelector<HTMLInputElement>('input[name="text"]')!;
    await act(async () => { setValue(text, 'The build needs Node 24 or later.'); });
    await act(async () => { button(entry('bbbb2222')!, 'Save')!.click(); });
    await vi.waitFor(() => expect(posts(daemon.calls)).toContainEqual({ action: 'edit', id: APPROVED.id, text: 'The build needs Node 24 or later.' }));

    await vi.waitFor(() => expect(button(entry('aaaa1111')!, 'Remove')?.disabled).toBe(false));
    await act(async () => { button(entry('aaaa1111')!, 'Remove')!.click(); });
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull());
    await act(async () => { button(document.querySelector('[role="alertdialog"]')!, 'Remove')!.click(); });
    await vi.waitFor(() => expect(posts(daemon.calls)).toContainEqual({ action: 'remove', id: PROPOSED.id }));
  });

  it('adds an entry to the repository chosen; the filter shows its entries only', async () => {
    const daemon = await boot();
    const filter = document.querySelector<HTMLSelectElement>('[data-slot="repo-memory"] select[aria-label="Repository"]')!;
    await act(async () => { filter.value = 'acme/lib'; filter.dispatchEvent(new Event('change', { bubbles: true })); });
    await vi.waitFor(() => expect(entry('aaaa1111')).toBeNull());
    expect(entry('bbbb2222')).not.toBeNull();
    const add = document.querySelector<HTMLElement>('[data-slot="memory-add"]')!;
    expect(add.querySelector<HTMLInputElement>('input[name="repo"]')!.value).toBe('acme/lib');
    await act(async () => { setValue(add.querySelector<HTMLInputElement>('input[name="text"]')!, 'Lint with npm run lint.'); });
    await act(async () => { button(add, 'Add an entry')!.click(); });
    await vi.waitFor(() => expect(posts(daemon.calls)).toContainEqual({ action: 'add', repo: 'acme/lib', kind: 'convention', text: 'Lint with npm run lint.' }));
  });

  it('saves the settings against the version read', async () => {
    const daemon = await boot();
    const s = document.querySelector<HTMLElement>('[data-slot="repo-memory-settings"]')!;
    await act(async () => { setValue(s.querySelector<HTMLInputElement>('input[aria-label="Expiry"]')!, '90'); });
    await act(async () => { button(s, 'Save settings')!.click(); });
    await vi.waitFor(() => expect(daemon.calls.find((c) => c.path === '/ui/api/repo-memory/settings')?.body).toEqual({ settings: { ...SETTINGS, expireDays: 90 }, version: 'v1' }));
  });

  it('a reader sees the entries and no act', async () => {
    await boot('viewer');
    expect(button(entry('aaaa1111')!, 'Approve')).toBeUndefined();
    expect(document.querySelector('[data-slot="memory-add"]')).toBeNull();
    expect(button(document, 'Save settings')).toBeUndefined();
  });
});
