// @vitest-environment happy-dom
// Issue #708, on the page: Add machine → A sandbox box takes the launch's parameters — CPUs, memory, time limit, which
// of the template's secrets and tools, one operation profile — filled in from the template's defaults, checked before
// Start, and posted with the launch. Settings → Vault: a template's form sets its limits, and the template shows them.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const READ = { operation: 'read', asset: { kind: 'cluster', name: 'lab' } };
const KUBE = {
  name: 'kube', image: 'img', secrets: ['KUBE', 'AWS'], profiles: [READ], savedBy: 'Ada', savedAt: '2026-10-11T10:00:00Z',
  approval: { image: 'img', secrets: ['KUBE', 'AWS'], by: 'Ada', at: '' }, pending: { secrets: [], image: false, profiles: [] },
  gives: ['KUBE', 'AWS'], radius: { level: 'low', reasons: [], profiles: [] },
  limits: { cpus: { default: 2, max: 4 }, memoryMb: { default: 2048, max: 4096 }, ttlMinutes: { default: 60, max: 240 } },
  tools: ['helm', 'kubectl'],
};
const VIEW = { secrets: [{ id: 's1', name: 'KUBE', setBy: 'Ada', createdAt: '', changedBy: 'Ada', changedAt: '' }], templates: [KUBE], requests: [] };

interface Call { path: string; method: string; body?: Record<string, unknown> }

function fakeDaemon(o: { launch?: boolean } = {}) {
  const calls: Call[] = [];
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [], locked: [] },
    '/api/machines': { machines: [] }, '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] }, '/api/questions': { questions: [] },
    '/api/sources': { sources: [] }, '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
    '/api/vault': VIEW,
    '/api/sandboxes': { launch: o.launch === false ? { available: false, problem: 'no socket.' } : { available: true, runtime: 'podman' }, boxes: [], problems: [] },
  };
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = String(input).split('?')[0]!;
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ path, method: init.method ?? 'GET', ...(body ? { body } : {}) });
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'admin', realm: 'github', name: 'alice', instanceAdmin: true }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (path === '/ui/api/vault') return json(200, VIEW);
    if (path === '/ui/api/machines/sandbox') return json(200, { container: 'hopper-sandbox-kube' });
    if (path === '/ui/api/machines/join') return json(200, { code: 'c0de', expiresAt: '2099-01-01T00:00:00.000Z', ...(body?.box ? { flags: '--cap-drop ALL --cpus 3 --memory 2048m' } : {}) });
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

function setup(o: { launch?: boolean } = {}) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const daemon = fakeDaemon(o);
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

async function openLaunch(o: { launch?: boolean } = {}) {
  const daemon = setup(o);
  vi.resetModules();
  const path = '../../ui/src/views/machine-join.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { JoinMachineForm } = (await import(path)) as { JoinMachineForm: (p: Record<string, unknown>) => ReturnType<typeof createElement> };
  const props = { config: { port: 4790, thisMachineRefused: true }, onDone: () => {}, onSsh: () => {} };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(JoinMachineForm, props)); });
  await click(buttons().find((b) => b.textContent?.startsWith('A sandbox box'))!);
  await vi.waitFor(() => expect(button('kube')).toBeDefined());
  await click(button('kube'));
  await vi.waitFor(() => expect(button(o.launch === false ? 'Show the line' : 'Start the box')).toBeDefined());
  return daemon;
}

describe('Add machine → A sandbox box: the launch\'s parameters (issue #708)', () => {
  it('shows the template\'s defaults and maximums; Start posts what the person set', async () => {
    const daemon = await openLaunch();
    expect(field('CPUs').value).toBe('2');
    expect(field('Memory in GiB').value).toBe('2');
    expect(field('Time limit in minutes').value).toBe('60');
    expect(document.body.textContent).toContain('at most 4');
    expect(document.body.textContent).toContain('at most 240');
    const secrets = document.querySelector('[role="group"][aria-label="Secrets for this box"]')!;
    expect(buttons(secrets).map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([['KUBE', 'true'], ['AWS', 'true']]);

    await type(field('CPUs'), '3');
    await click(button('AWS', secrets));
    await click(button('read on cluster lab'));
    await click(button('kubectl', document.querySelector('[role="group"][aria-label="Tools for this box"]')!));
    await click(button('Start the box'));
    await vi.waitFor(() => expect(daemon.calls.find((x) => x.path === '/ui/api/machines/sandbox')).toBeDefined());
    expect(daemon.calls.find((x) => x.path === '/ui/api/machines/sandbox')!.body).toEqual({
      agent: 'claude', template: 'kube',
      params: { cpus: 3, memoryMb: 2048, ttlMinutes: 60, secrets: ['KUBE'], profile: 'read/cluster/lab', tools: ['helm'] },
    });
  });

  it('a value the template does not allow: says why, and Start waits', async () => {
    const daemon = await openLaunch();
    await type(field('Memory in GiB'), '6');
    expect(document.querySelector('[data-launch-problem]')!.textContent).toBe('Memory: at most 4 GiB for the template kube');
    expect(button('Start the box').disabled).toBe(true);
    await type(field('Memory in GiB'), '4');
    expect(document.querySelector('[data-launch-problem]')).toBeNull();
    expect(button('Start the box').disabled).toBe(false);
    expect(daemon.calls.some((x) => x.path === '/ui/api/machines/sandbox')).toBe(false);
  });
});

describe('Add machine → A sandbox box: the line, when the hopper does not start the box (issue #708)', () => {
  it('takes CPUs and memory from the template\'s defaults; the line carries the flags the hopper built for them', async () => {
    const daemon = await openLaunch({ launch: false });
    expect(field('CPUs').value).toBe('2');
    expect(field('Memory in GiB').value).toBe('2');
    // A box the hopper does not start has no record: no time limit, secrets subset, profile or tools to give it.
    expect(document.querySelector('input[aria-label="Time limit in minutes"]')).toBeNull();
    expect(document.querySelector('[role="group"][aria-label="Secrets for this box"]')).toBeNull();
    await type(field('CPUs'), '3');
    await click(button('Show the line'));
    await vi.waitFor(() => expect(document.querySelector('code')?.textContent).toContain('--cpus 3 --memory 2048m'));
    expect(daemon.calls.find((x) => x.path === '/ui/api/machines/join')!.body).toEqual({ template: 'kube', box: { cpus: 3, memoryMb: 2048 } });
  });

  it('a value the template does not allow: says why, and no line is made', async () => {
    const daemon = await openLaunch({ launch: false });
    await type(field('CPUs'), '9');
    expect(document.querySelector('[data-launch-problem]')!.textContent).toBe('CPUs: at most 4 for the template kube');
    expect(button('Show the line').disabled).toBe(true);
    expect(daemon.calls.some((x) => x.path === '/ui/api/machines/join')).toBe(false);
  });
});

describe('Settings → Vault: a template\'s limits (issue #708)', () => {
  async function boot() {
    const daemon = setup();
    window.location.hash = '#settings/vault';
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
    expect(item()!.textContent).toContain('2 CPUs, at most 4 · 2 GiB, at most 4 GiB · time limit 60 minutes, at most 240 · home kept');
    await click(button('Edit', item()!));
    const form = item()!.querySelector('form')!;
    expect(field('CPUs default', form).value).toBe('2');
    await type(field('CPUs max', form), '6');
    await type(field('Time limit default', form), '');
    await click(form.querySelector<HTMLInputElement>('input[type="checkbox"][aria-label="Keep the home volume when a box goes"]')!);
    await click(button('Save template', form));
    await vi.waitFor(() => expect(daemon.calls.find((x) => x.path === '/ui/api/vault')).toBeDefined());
    expect(daemon.calls.find((x) => x.path === '/ui/api/vault')!.body).toMatchObject({
      action: 'save-template', name: 'kube',
      limits: { cpus: { default: 2, max: 6 }, memoryMb: { default: 2048, max: 4096 }, ttlMinutes: { max: 240 }, keepHome: false },
    });
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
