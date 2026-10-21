// @vitest-environment happy-dom
// Issue #715, part 6, on the page: Settings → Vault, a template's form sets the state backend of each terraform workspace
// profile — its bucket, region and key prefix —, which the read-only check pushes a state of its own to; Save posts it
// on that profile. The template shows it.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const WORKSPACE = { operation: 'read', asset: { kind: 'terraform-workspace', name: 'shop-prod' } };
const ROLE = { operation: 'read', asset: { kind: 'aws-role', name: '123456789012/readonly' } };
const TF = {
  name: 'tf', image: 'img', secrets: [], profiles: [WORKSPACE, ROLE], savedBy: 'Ada', savedAt: '2026-10-11T10:00:00Z',
  approval: { image: 'img', secrets: [], by: 'Ada', at: '' }, pending: { secrets: [], image: false, egress: [], profiles: [] },
  gives: [], radius: { level: 'low', reasons: [], profiles: [] }, tools: ['aws', 'terraform'],
};

interface Call { path: string; method: string; body?: Record<string, unknown> }
let view: Record<string, unknown> = {};

function fakeDaemon() {
  const calls: Call[] = [];
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [], locked: [] },
    '/api/machines': { machines: [] }, '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] }, '/api/questions': { questions: [] },
    '/api/sources': { sources: [] }, '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
    '/api/sandboxes': { launch: { available: true, runtime: 'podman' }, boxes: [], problems: [] },
  };
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = String(input).split('?')[0]!;
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ path, method: init.method ?? 'GET', ...(body ? { body } : {}) });
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'admin', realm: 'github', name: 'alice', instanceAdmin: true }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (path === '/ui/api/vault' || path === '/api/vault') return json(200, view);
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
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

const button = (text: string, within: ParentNode = document): HTMLButtonElement => {
  const b = [...within.querySelectorAll('button')].find((x) => x.textContent?.trim() === text);
  if (!b) throw new Error(`no button ${text}`);
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
const item = (): HTMLElement | null => [...document.querySelectorAll('li')].find((l) => l.textContent?.includes('Gives now')) ?? null;

async function boot(t: Record<string, unknown>) {
  view = { secrets: [], templates: [t], requests: [] };
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const daemon = fakeDaemon();
  vi.stubGlobal('fetch', daemon.fetch);
  vi.stubGlobal('EventSource', FakeEventSource);
  window.location.hash = '#vault';
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx';
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(item()).not.toBeNull());
  return daemon;
}

describe('Settings → Vault: a terraform workspace\'s state backend (issue #715)', () => {
  it('the form sets the backend of a terraform workspace profile, and Save posts it on that profile', async () => {
    const daemon = await boot(TF);
    expect(item()!.textContent).toContain('shop-prod: no state backend');
    await click(button('Edit', item()!));
    const form = item()!.querySelector('form')!;
    // Only a terraform workspace profile takes a backend.
    expect(form.querySelectorAll('input[aria-label^="State bucket of"]').length).toBe(1);
    await type(field('State bucket of shop-prod', form), 'shop-state');
    await type(field('State region of shop-prod', form), 'eu-west-1');
    await type(field('State key prefix of shop-prod', form), 'env/prod/');
    await click(button('Save template', form));
    await vi.waitFor(() => expect(daemon.calls.find((x) => x.path === '/ui/api/vault' && x.method === 'POST')).toBeDefined());
    expect(daemon.calls.find((x) => x.path === '/ui/api/vault' && x.method === 'POST')!.body).toMatchObject({
      action: 'save-template', name: 'tf',
      profiles: [{ ...WORKSPACE, backend: { bucket: 'shop-state', region: 'eu-west-1', keyPrefix: 'env/prod' } }, ROLE],
    });
  });

  it('the template shows its backend; the form starts from it, and a bucket cleared drops it', async () => {
    const backend = { bucket: 'shop-state', region: 'eu-west-1', keyPrefix: 'env/prod' };
    const daemon = await boot({ ...TF, profiles: [{ ...WORKSPACE, backend }, ROLE] });
    expect(item()!.textContent).toContain('shop-prod: state in s3://shop-state/env/prod (eu-west-1)');
    await click(button('Edit', item()!));
    const form = item()!.querySelector('form')!;
    expect(field('State bucket of shop-prod', form).value).toBe('shop-state');
    await type(field('State bucket of shop-prod', form), '');
    await click(button('Save template', form));
    await vi.waitFor(() => expect(daemon.calls.find((x) => x.path === '/ui/api/vault' && x.method === 'POST')).toBeDefined());
    expect((daemon.calls.find((x) => x.path === '/ui/api/vault' && x.method === 'POST')!.body as { profiles: unknown[] }).profiles).toEqual([WORKSPACE, ROLE]);
  });
});
