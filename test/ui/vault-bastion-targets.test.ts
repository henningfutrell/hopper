// @vitest-environment happy-dom
// Issue #2146, on the page: Vault, a template's card lists its bastion targets, each a person has not approved
// marked `(waits)`; its form edits them — each <cluster>/<namespace>/<svc|pod|deploy>/<name>:<port> —, Save posts them as
// `bastionTargets`, and a word that is no target stops the save.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const OBSERVE = { operation: 'observe', asset: { kind: 'namespace', name: 'uat/monitoring' } };
const PROM = 'uat/monitoring/svc/prometheus-server:9090', GRAFANA = 'uat/monitoring/svc/grafana:80';
const OBS = {
  name: 'observe-uat', image: 'img', secrets: [], profiles: [OBSERVE], savedBy: 'Ada', savedAt: '2026-10-20T10:00:00Z', bastionTargets: [GRAFANA, PROM],
  approval: { image: 'img', secrets: [], bastionTargets: [PROM], by: 'Ada', at: '' }, pending: { secrets: [], image: false, egress: [], bastionTargets: [GRAFANA], profiles: [] },
  gives: [], radius: { level: 'high', reasons: [], profiles: [] }, tools: ['kubectl'], readOnly: true,
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

describe('Vault: a template\'s bastion targets (issue #2146)', () => {
  it('the card lists them and marks the one that waits', async () => {
    await boot(OBS);
    expect(item()!.textContent).toContain(`Bastion targets${GRAFANA} (waits), ${PROM}`);
  });

  it('the form starts from them; Save posts the targets typed, split by spaces or commas', async () => {
    const daemon = await boot(OBS);
    await click(button('Edit', item()!));
    const form = item()!.querySelector('form')!;
    expect(field('Bastion targets', form).value).toBe(`${GRAFANA} ${PROM}`);
    await type(field('Bastion targets', form), `${PROM}, uat/monitoring/svc/loki:3100 ${PROM}`);
    await click(button('Save template', form));
    await vi.waitFor(() => expect(daemon.calls.find((x) => x.path === '/ui/api/vault' && x.method === 'POST')).toBeDefined());
    expect(daemon.calls.find((x) => x.path === '/ui/api/vault' && x.method === 'POST')!.body).toMatchObject({
      action: 'save-template', name: 'observe-uat', bastionTargets: [PROM, 'uat/monitoring/svc/loki:3100'],
    });
  });

  it('a word that is no target says so and stops the save; an empty field saves none', async () => {
    const daemon = await boot(OBS);
    await click(button('Edit', item()!));
    const form = item()!.querySelector('form')!;
    await type(field('Bastion targets', form), `${PROM} uat/monitoring/secret/x:1`);
    expect(form.textContent).toContain('uat/monitoring/secret/x:1 is not <cluster>/<namespace>/<svc|pod|deploy>/<name>:<port>');
    expect(button('Save template', form).disabled).toBe(true);
    await type(field('Bastion targets', form), '');
    await click(button('Save template', form));
    await vi.waitFor(() => expect(daemon.calls.find((x) => x.path === '/ui/api/vault' && x.method === 'POST')).toBeDefined());
    expect(daemon.calls.find((x) => x.path === '/ui/api/vault' && x.method === 'POST')!.body).toMatchObject({ bastionTargets: [] });
  });
});
