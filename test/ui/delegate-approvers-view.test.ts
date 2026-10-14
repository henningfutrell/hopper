// @vitest-environment happy-dom
// Access requests, "Delegate approvers" (issue #1138), rendered in happy-dom inside the whole app against a fake of the
// daemon's HTTP surface: the owner mints a delegate approver — a name, its approver policy, how long it lives — as a grant
// of the preset delegate-approver; its refresh token is shown once with the command an agent runs; each delegate is
// listed with what its policy denies, and Revoke ends it. A job's grant ask has Deny beside Grant, and a grant a delegate
// made says so, with the time.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { delegatesOf, denyOf, policyText } from '../../ui/src/model/delegates.ts';

const JOB = 'f3b1c2d4-0000-4000-8000-000000000001';
const ASK = { job: JOB, key: 'https://github.com/octo-org/hello/issues/7', machine: 'hopper-sandbox-web', template: 'web', names: ['KUBE_TOKEN'], askedAt: '2026-10-11T12:00:00.000Z' };
const GRANT = {
  key: 'https://github.com/octo-org/hello/issues/9', job: 'a1b2c3d4-0000-4000-8000-000000000002', by: 'cos (delegate of alice)', at: '2026-10-11T11:05:00.000Z', made: 'grant',
  item: { title: 'Fix the login', repo: 'octo-org/hello', job: 'a1b2c3d4-0000-4000-8000-000000000002', status: 'running', stale: false },
};
const VIEW = { secrets: [], templates: [], grantAsks: [ASK], grants: [GRANT] };
const COS = { id: '0123456789abcdef', label: 'cos', role: 'admin', box: true, scopes: ['vault:read'], createdAt: '2026-10-11T10:00:00Z', endsAt: '2026-11-10T10:00:00Z', idleEndsAt: '2026-11-10T10:00:00Z', delegate: { deny: ['prod'] } };
const BOT = { ...COS, id: 'fedcba9876543210', label: 'grok-bot', scopes: ['*:read'], delegate: undefined };

interface Call { path: string; method: string; body?: Record<string, unknown> }

function fakeDaemon() {
  const calls: Call[] = [];
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  let grants: unknown[] = [COS, BOT];
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
    if (path === '/api/api-tokens') return json(200, { grants, tokens: [], scopes: [], settings: { tokenMinutes: 10, min: 5, max: 15 } });
    if (path === '/ui/api/api-tokens' && body?.action === 'mint') {
      const view = { ...COS, id: '1111111111111111', label: body.label, delegate: { deny: body.deny } };
      grants = [...grants, view];
      return json(200, { grant: view.id, token: 'hopper_at_x', expiresAt: '2026-10-11T10:10:00Z', refresh: 'hopper_rt_once', view });
    }
    if (path === '/ui/api/api-tokens' && body?.action === 'revoke') {
      grants = grants.filter((g) => (g as { id: string }).id !== body.id);
      return json(200, { grants, tokens: [] });
    }
    if (path === `/ui/api/jobs/${JOB}/deny-vault`) return json(200, { ...VIEW, grantAsks: [] });
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

const panel = (): HTMLElement | null => document.querySelector('[data-slot="delegate-approvers"]');
const delegateRow = (name: string): HTMLElement | null => [...(panel()?.querySelectorAll('li') ?? [])].find((l) => l.textContent?.includes(name)) as HTMLElement | undefined ?? null;
const askCard = (): HTMLElement | null => [...document.querySelectorAll('li')].find((l) => l.textContent?.includes('Grant this job the vault')) ?? null;
const buttonIn = (el: Element, text: string): HTMLButtonElement => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)! as HTMLButtonElement;
const type = (input: HTMLInputElement, value: string) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  set.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

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
  await vi.waitFor(() => expect(delegateRow('cos')).not.toBeNull());
  return daemon;
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('delegate approvers model (issue #1138)', () => {
  it('lists only the delegate approvers; says what each policy keeps; reads the deny entries a person types', () => {
    expect(delegatesOf([COS, BOT] as never).map((g) => g.label)).toEqual(['cos']);
    expect(policyText(['prod', 'uat'])).toBe('never approves what names prod or uat: that stays yours');
    expect(policyText([])).toBe('approves anything that waits for a person');
    expect(denyOf(' prod, uat  prod ,')).toEqual(['prod', 'uat']);
  });
});

describe('Access requests: delegate approvers (issue #1138)', () => {
  it('lists each delegate with what its policy denies, and no other grant; Revoke ends it', async () => {
    const daemon = await boot();
    expect(delegateRow('cos')!.textContent).toContain('prod');
    expect(delegateRow('grok-bot')).toBeNull();
    await act(async () => { buttonIn(delegateRow('cos')!, 'Revoke').click(); });
    await act(async () => { buttonIn(document.querySelector('[role="alertdialog"]')!, 'Revoke').click(); });
    await vi.waitFor(() => expect(daemon.calls.find((x) => x.path === '/ui/api/api-tokens' && x.body?.action === 'revoke')).toMatchObject({ body: { action: 'revoke', id: COS.id } }));
    await vi.waitFor(() => expect(delegateRow('cos')).toBeNull());
  });

  it('mints a delegate of the preset with its policy; its refresh token is shown once, with the command an agent runs', async () => {
    const daemon = await boot();
    await act(async () => { buttonIn(panel()!, 'Mint delegate').click(); });
    await act(async () => { type(panel()!.querySelector('input[name="delegate-name"]')!, 'cos2'); });
    await act(async () => { type(panel()!.querySelector('input[name="delegate-deny"]')!, 'prod, uat'); });
    await act(async () => { (panel()!.querySelector('form') as HTMLFormElement).requestSubmit(); });
    await vi.waitFor(() => expect(daemon.calls.find((x) => x.body?.action === 'mint')).toMatchObject({
      path: '/ui/api/api-tokens', body: { action: 'mint', label: 'cos2', preset: 'delegate-approver', deny: ['prod', 'uat'], days: 30 },
    }));
    await vi.waitFor(() => expect(panel()!.textContent).toContain('hopper grant approve'));
    expect((panel()!.querySelector('input[readonly]') as HTMLInputElement).value).toBe('hopper_rt_once');
    expect(panel()!.textContent).not.toContain('hopper_at_x');
  });

  it('a grant ask has Deny beside Grant; a grant a delegate made names it and the time', async () => {
    const daemon = await boot();
    await vi.waitFor(() => expect(askCard()).not.toBeNull());
    const made = [...document.querySelectorAll('li')].find((l) => l.textContent?.includes('Fix the login'))!;
    expect(made.textContent).toContain('granted by cos (delegate of alice)');
    expect(made.textContent).toContain('2026-10-11 11:05 UTC');
    await act(async () => { buttonIn(askCard()!, 'Deny').click(); });
    await vi.waitFor(() => expect(daemon.calls.find((x) => x.path.endsWith('/deny-vault'))).toMatchObject({ path: `/ui/api/jobs/${JOB}/deny-vault`, method: 'POST' }));
    await vi.waitFor(() => expect(askCard()).toBeNull());
  });
});
