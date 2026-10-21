// @vitest-environment happy-dom
// Settings → Podman hosts (issue #2272), rendered in happy-dom inside the whole app against a fake of the daemon's HTTP
// surface: a person adds a Podman host — its host key read and its fingerprint shown before it is pinned —, with the most
// CPUs and memory a box gets there, and the whole list is saved with the version read. A host of the sandbox host shows
// its place; one that is not is added to the sandbox host, last, with one click. The section shows the authorized_keys
// line the host gives the hopper's key.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
const EXISTING = { name: 'box-vm', ssh: 'sandbox@box-vm', hostKey: KEY, cpus: 4 };

interface Call { path: string; method: string; body?: Record<string, unknown> }

function fakeDaemon() {
  const calls: Call[] = [];
  let view = { hosts: [EXISTING] as unknown[], version: 'v1' };
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [], locked: [] },
    '/api/machines': { machines: [], sandboxHost: ['local'] }, '/api/machines/config': { ssh: { publicKey: 'ssh-ed25519 AAAAhopper hopper' } }, '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] }, '/api/questions': { questions: [] },
    '/api/sources': { sources: [] }, '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
  };
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = String(input).split('?')[0]!;
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ path, method: init.method ?? 'GET', ...(body ? { body } : {}) });
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'admin', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (path === '/api/podman-hosts') return json(200, view);
    if (path === '/ui/api/machines/sandbox-host') return json(200, { hosts: body!.hosts });
    if (path === '/ui/api/machines/host-key') return json(200, { ssh: body!.ssh, hostKey: KEY, fingerprint: 'SHA256:abc123', known: false });
    if (path === '/ui/api/podman-hosts') { view = { hosts: body!.hosts as unknown[], version: 'v2' }; return json(200, view); }
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
const panel = () => document.querySelector('[data-slot="podman-hosts"]');
const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
const click = (b: HTMLElement | undefined) => act(async () => { b!.click(); });
const type = (el: HTMLInputElement, text: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});

async function boot() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#settings/podman-hosts';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const daemon = fakeDaemon();
  vi.stubGlobal('fetch', daemon.fetch);
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(panel()?.querySelector('[data-slot="podman-host"]')).not.toBeNull());
  return daemon;
}

afterEach(() => { act(() => root?.unmount()); root = undefined; vi.unstubAllGlobals(); });

describe('Settings → Podman hosts (issue #2272)', () => {
  it('adds a host: reads its host key, shows the fingerprint, pins that key and saves the whole list', async () => {
    const daemon = await boot();
    expect(panel()!.textContent).toContain('sandbox@box-vm');
    // The authorized_keys line, whole: the forced command first, then the hopper's own public key.
    await vi.waitFor(() => expect(panel()!.querySelector('[data-slot="podman-host-key-line"]')!.textContent).toBe('command="podman system dial-stdio",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAAhopper hopper'));
    await click(button('Add a Podman host'));
    const form = panel()!.querySelector('[data-slot="podman-host-form"]')!;
    const inputs = [...form.querySelectorAll('input')];
    await type(inputs[0]!, 'big-vm');
    await type(inputs[1]!, 'sandbox@big-vm');
    await type(inputs[3]!, '8');
    await type(inputs[4]!, '16384');
    await click(button('Read its host key'));
    await vi.waitFor(() => expect(panel()!.querySelector('[data-slot="podman-host-key"]')?.textContent).toContain('SHA256:abc123'));
    expect(daemon.calls.find((c) => c.path === '/ui/api/machines/host-key')?.body).toEqual({ ssh: 'sandbox@big-vm' });
    await click(button('Pin this key and save'));
    await vi.waitFor(() => expect(daemon.calls.some((c) => c.path === '/ui/api/podman-hosts')).toBe(true));
    expect(daemon.calls.find((c) => c.path === '/ui/api/podman-hosts')!.body).toEqual({
      version: 'v1', hosts: [EXISTING, { name: 'big-vm', ssh: 'sandbox@big-vm', hostKey: KEY, cpus: 8, memoryMb: 16384 }],
    });
    await vi.waitFor(() => expect(panel()!.querySelectorAll('[data-slot="podman-host"]')).toHaveLength(2));
  });

  it('adds a host to the sandbox host, last', async () => {
    const daemon = await boot();
    await click(button('Use as sandbox host'));
    await vi.waitFor(() => expect(daemon.calls.find((c) => c.path === '/ui/api/machines/sandbox-host')?.body).toEqual({ hosts: ['local', 'box-vm'] }));
  });
});
