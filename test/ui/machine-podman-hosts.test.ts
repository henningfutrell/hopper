// @vitest-environment happy-dom
// Issue #2272 part 3: the Podman hosts on Machines, rendered inside the whole app against a fake of the daemon's HTTP
// surface. Each Podman host shows whether it is the sandbox host and its place there, how many sandboxes run there now
// (its open sandbox runs), and its CPU and memory now (GET /api/podman-hosts/status), to size it from real numbers. A
// host that cannot be reached says it is offline, and why. With no Podman host, the section is not there.
//
// Feature: the Podman hosts on Machines
//   Scenario: a Podman host of the sandbox host shows its place, its live sandbox count, its CPU and memory
//   Scenario: a Podman host that cannot be reached says it is offline, and why
//   Scenario: no Podman host: no section
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const GiB = 1024 ** 3;
const AT = '2026-10-21T12:00:00.000Z';
const DESK = { id: 'desk', label: 'desk', maxLanes: 2, online: true, executors: ['herdr-claude'], usage: [], lanes: [] };
let HOSTS: string[] = [];
let STATUS: unknown[] = [];
const RUN = (id: string, machine: string, ended?: string) => ({ id, jobId: 'j1', template: 't', box: `hopper-need-t-${id}`, machine, startedAt: '2026-10-21T11:00:00.000Z', ...(ended ? { endedAt: ended } : {}) });
const RUNS = [RUN('a', 'box-vm'), RUN('b', 'box-vm'), RUN('c', 'box-vm', '2026-10-21T11:01:00.000Z'), RUN('d', 'local')];

function fakeDaemon() {
  const routes: Record<string, () => unknown> = {
    '/api/health': () => ({ ok: true, version: '0', router: 'pass-through', fallback: false, executors: ['herdr-claude'], uptimeS: 1 }),
    '/api/queue': () => ({ waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], waitingOn: [], ended: [], locked: [] }),
    '/api/machines': () => ({ machines: [DESK], sandboxHost: HOSTS }), '/api/sandboxes': () => ({ runs: RUNS, problems: [] }), '/api/decisions': () => ({ decisions: [] }), '/api/events': () => ({ events: [] }),
    '/api/podman-hosts/status': () => ({ hosts: STATUS }),
    '/api/webhooks': () => ({ subscriptions: [] }), '/api/webhooks/deliveries': () => ({ deliveries: [] }),
    '/api/questions': () => ({ questions: [] }), '/api/sources': () => ({ sources: [] }),
    '/api/usage': () => ({ readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }), '/api/accounts': () => ({ accounts: [] }),
    '/api/credential-check': () => ({ strict: false }),
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
const card = (name: string) => document.querySelector<HTMLElement>(`[data-slot="podman-host-card"][data-host="${name}"]`);

async function boot(hosts: string[], status: unknown[]) {
  HOSTS = hosts;
  STATUS = status;
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
  await vi.waitFor(() => expect(document.querySelector('[data-slot="machine-cards"]')).not.toBeNull());
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('the Podman hosts on Machines (issue #2272)', () => {
  it('a Podman host of the sandbox host shows its place, its live sandbox count, its CPU and memory', async () => {
    await boot(['box-vm', 'local'], [{ name: 'box-vm', at: AT, cpus: 8, cpuBusyFrac: 0.25, memTotalBytes: 16 * GiB, memUsedBytes: 10 * GiB }]);
    const c = await vi.waitFor(() => { const x = card('box-vm'); expect(x).not.toBeNull(); return x!; });
    expect(c.textContent).toContain('The sandbox host');
    expect(c.textContent).toContain('2 sandboxes run here now.');
    expect(c.querySelector('[data-slot="podman-host-cpu"]')?.textContent).toBe('25% of 8 CPUs');
    expect(c.querySelector('[data-slot="podman-host-memory"]')?.textContent).toBe('10.0 of 16.0 GiB');
    expect(c.textContent).not.toContain('offline');
  });

  it('a Podman host that cannot be reached says it is offline, and why', async () => {
    await boot(['box-vm', 'old-vm'], [
      { name: 'box-vm', at: AT, cpus: 8 },
      { name: 'old-vm', at: AT, problem: 'cannot reach podman on old-vm: ssh to old-vm failed (exit 255): Permission denied (publickey).' },
      { name: 'spare-vm', at: AT, cpus: 2 },
    ]);
    const c = await vi.waitFor(() => { const x = card('old-vm'); expect(x).not.toBeNull(); return x!; });
    expect(c.textContent).toContain('Sandbox host, place 2');
    expect(c.querySelector('[role="alert"]')?.textContent).toBe('sandbox host old-vm is offline: cannot reach podman on old-vm: ssh to old-vm failed (exit 255): Permission denied (publickey).');
    expect(c.textContent).toContain('No sandbox runs here now.');
    expect(card('spare-vm')!.textContent).toContain('Not the sandbox host');
  });

  it('no Podman host: no section', async () => {
    await boot(['local'], []);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(document.querySelector('[data-section="podman-hosts"]')).toBeNull();
  });
});
