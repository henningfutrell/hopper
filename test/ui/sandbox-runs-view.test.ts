// @vitest-environment happy-dom
// Issue #991, rendered in happy-dom inside the whole app against a fake of the daemon's HTTP surface. Access requests,
// Sandbox runs: a run a job asked for waits with its job and template; Approve posts it after the confirm; Decline posts
// the reason; the runs that started are listed with who approved them; the nav badge counts the run that waits.
// Settings → Vault, Sandbox approvals: the toggles post what changed, and YOLO posts both.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const WAITING = { id: 'q1', jobId: 'f3b1c2d4-0000-4000-8000-000000000001', jobTitle: 'Check the AWS bill', template: 'asked-3f2a9c1d0e4b', state: 'waiting', askedAt: '2026-10-13T10:00:00.000Z' };
const RUNNING = { id: 'q2', jobId: 'a1b2c3d4-0000-4000-8000-000000000002', template: 'asked-3f2a9c1d0e4b', state: 'running', askedAt: '2026-10-13T09:00:00.000Z', approvedBy: 'skip sandbox approval', container: 'hopper-sandbox-asked-1' };
const WAITING_2 = { ...WAITING, id: 'q3', jobId: 'c1b2c3d4-0000-4000-8000-000000000003', jobTitle: 'Read the cluster', template: 'asked-9a8b7c6d5e4f' };
const WRITE = { operation: 'write', asset: { kind: 'aws-account', name: '123456789012' } };
const HIGH = {
  name: 'asked-0a1b2c3d4e5f', image: 'ghcr.io/henningfutrell/hopper:box-claude', secrets: [], profiles: [WRITE], gives: [], savedBy: 'job j', savedAt: '2026-10-13T09:00:00.000Z',
  pending: { secrets: [], image: true, profiles: [WRITE] }, radius: { level: 'high', reasons: ['write on aws-account 123456789012: it changes the asset'], profiles: [] },
};
const VIEW = { secrets: [], templates: [HIGH], sandboxRequests: [WAITING, WAITING_2, RUNNING], sandboxApprovals: { skipTemplateApproval: false, skipSandboxApproval: false } };

interface Call { path: string; method: string; body?: Record<string, unknown> }

function fakeDaemon(o: { hold?: boolean } = {}) {
  const calls: Call[] = [];
  let release = (): void => {};
  const held = new Promise<void>((r) => { release = r; });
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
    if (path === '/ui/api/sandbox-requests' && o.hold) { await held; return json(200, VIEW); }
    if (path === '/ui/api/sandbox-requests' || path === '/ui/api/sandbox-approvals' || path === '/ui/api/vault') return json(200, VIEW);
    if (path in routes) return json(200, routes[path]);
    return json(404, { error: 'not found' });
  });
  return { fetch, calls, release: () => release() };
}

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

let root: Root | undefined;

async function boot(hash: string, ready: () => unknown, o: { hold?: boolean } = {}) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = hash;
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const daemon = fakeDaemon(o);
  vi.stubGlobal('fetch', daemon.fetch);
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(ready()).toBeTruthy());
  return daemon;
}

const runs = (): HTMLElement | null => document.querySelector('[data-access-panel="sandbox-runs"]');
const approvals = (): HTMLElement | null => document.querySelector('[data-slot="sandbox-approvals"]');
const buttonIn = (el: ParentNode, text: string): HTMLButtonElement => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)! as HTMLButtonElement;

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

describe('Access requests: sandbox runs (issue #991)', () => {
  it('shows the run that waits with its job and template; Approve posts it after the confirm; the started run says who approved it', async () => {
    const daemon = await boot('#access-requests', runs);
    const panel = runs()!;
    expect(panel.textContent).toContain('asked-3f2a9c1d0e4b');
    expect(panel.textContent).toContain('Check the AWS bill');
    expect(panel.textContent).toContain('runs as hopper-sandbox-asked-1, approved by skip sandbox approval');
    await act(async () => { buttonIn(panel, 'Approve').click(); });
    const confirm = () => [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find((b) => b.textContent?.trim() === 'Approve');
    await vi.waitFor(() => expect(confirm()).toBeDefined());
    await act(async () => { confirm()!.click(); });
    await vi.waitFor(() => expect(daemon.calls.find((x) => x.path === '/ui/api/sandbox-requests')).toBeDefined());
    expect(daemon.calls.find((x) => x.path === '/ui/api/sandbox-requests')!.body).toEqual({ action: 'approve', id: 'q1' });
  });

  it('Decline needs a reason, then posts it', async () => {
    const daemon = await boot('#access-requests', runs);
    const panel = runs()!;
    expect(buttonIn(panel, 'Decline').disabled).toBe(true);
    await type(panel.querySelector<HTMLInputElement>('input[placeholder="Why not (the job is told)"]')!, 'use the lab account');
    await act(async () => { buttonIn(runs()!, 'Decline').click(); });
    await vi.waitFor(() => expect(daemon.calls.find((x) => x.path === '/ui/api/sandbox-requests')).toBeDefined());
    expect(daemon.calls.find((x) => x.path === '/ui/api/sandbox-requests')!.body).toEqual({ action: 'decline', id: 'q1', reason: 'use the lab account' });
  });
});

describe('Settings → Vault: sandbox approvals (issue #991)', () => {
  it('says a person approves each; YOLO posts both on; a toggle posts itself', async () => {
    const daemon = await boot('#settings/vault', approvals);
    const panel = approvals()!;
    expect(panel.textContent).toContain('Templates and runs of low blast radius are approved with no person. A person approves each other new template and sandbox run.');
    await act(async () => { panel.querySelector<HTMLButtonElement>('[aria-label="YOLO"]')!.click(); });
    await vi.waitFor(() => expect(daemon.calls.find((x) => x.path === '/ui/api/sandbox-approvals')).toBeDefined());
    expect(daemon.calls.find((x) => x.path === '/ui/api/sandbox-approvals')!.body).toEqual({ yolo: true });
    await act(async () => { approvals()!.querySelector<HTMLButtonElement>('[aria-label="Skip sandbox approval"]')!.click(); });
    await vi.waitFor(() => expect(daemon.calls.filter((x) => x.path === '/ui/api/sandbox-approvals')).toHaveLength(2));
    expect(daemon.calls.filter((x) => x.path === '/ui/api/sandbox-approvals')[1]!.body).toEqual({ skipSandboxApproval: true });
  });
});

const confirmed = async (): Promise<void> => {
  const confirm = () => [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find((b) => /^Approve/.test(b.textContent?.trim() ?? ''));
  await vi.waitFor(() => expect(confirm()).toBeDefined());
  await act(async () => { confirm()!.click(); });
};
const card = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-sandbox-request="${id}"]`)!;

describe('approvals that do not block each other (issue #1001)', () => {
  it('while one approval is pending, the other cards stay clickable, and only that card shows its progress', async () => {
    const daemon = await boot('#access-requests', runs, { hold: true });
    await act(async () => { buttonIn(card('q1'), 'Approve').click(); });
    await confirmed();
    await vi.waitFor(() => expect(card('q1').textContent).toContain('Approving…'));
    expect(buttonIn(card('q3'), 'Approve').disabled).toBe(false);
    expect(card('q3').textContent).not.toContain('Approving…');
    await act(async () => { buttonIn(card('q3'), 'Approve').click(); });
    await confirmed();
    await vi.waitFor(() => expect(daemon.calls.filter((x) => x.path === '/ui/api/sandbox-requests')).toHaveLength(2));
    expect(daemon.calls.filter((x) => x.path === '/ui/api/sandbox-requests').map((x) => x.body)).toEqual([{ action: 'approve', id: 'q1' }, { action: 'approve', id: 'q3' }]);
    await act(async () => { daemon.release(); });
  });

  it('a high-radius template shows one Approve all listed action that approves the template and each listed profile', async () => {
    const daemon = await boot('#access-requests', () => document.querySelector(`[data-template-approval="${HIGH.name}"]`));
    const t = document.querySelector<HTMLElement>(`[data-template-approval="${HIGH.name}"]`)!;
    const labels = [...t.querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(labels).toEqual(['Approve all listed']);
    await act(async () => { buttonIn(t, 'Approve all listed').click(); });
    await confirmed();
    await vi.waitFor(() => expect(daemon.calls.filter((x) => x.path === '/ui/api/vault')).toHaveLength(2));
    expect(daemon.calls.filter((x) => x.path === '/ui/api/vault').map((x) => x.body)).toEqual([
      { action: 'approve-template', name: HIGH.name },
      { action: 'approve-profile', name: HIGH.name, ...WRITE },
    ]);
  });
});

describe('Settings → Vault: the auto-approve policy (issue #1001)', () => {
  it('shows low on and medium and high off by default; a level posts itself', async () => {
    const daemon = await boot('#settings/vault', approvals);
    const sw = (level: string) => approvals()!.querySelector<HTMLButtonElement>(`[aria-label="Auto-approve ${level} radius"]`)!;
    expect(sw('low').getAttribute('aria-checked')).toBe('true');
    expect(sw('medium').getAttribute('aria-checked')).toBe('false');
    expect(sw('high').getAttribute('aria-checked')).toBe('false');
    await act(async () => { sw('medium').click(); });
    await vi.waitFor(() => expect(daemon.calls.find((x) => x.path === '/ui/api/sandbox-approvals')).toBeDefined());
    expect(daemon.calls.find((x) => x.path === '/ui/api/sandbox-approvals')!.body).toEqual({ autoApprove: { medium: true } });
  });
});
