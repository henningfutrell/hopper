// @vitest-environment happy-dom
// The Question gates panel in the Settings view (issues #18, #151), rendered in happy-dom inside the whole
// app against a fake of the daemon's HTTP surface. It shows the chain a question goes through, lets
// the owner add, remove, reorder and tune the escalation levels through POST /ui/api/plugins, and
// edits the rules through POST /ui/api/rules with the version the draft was based on. An unsaved
// draft survives a reload. A level's model is chosen from the models the plugin lists, not typed; its
// machine from the configured machines, and always set (issue #174).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const RULES = { text: '- prefer small PRs\n', version: 'v1', missing: false };
const GATES = {
  rules: RULES,
  riskRules: [
    { name: 'delete', describe: 'deleting or wiping things' },
    { name: 'deploy', describe: 'deploying or publishing' },
  ],
};
const claudeSchema = {
  type: 'object',
  properties: {
    bin: { type: 'string', default: 'claude', commandBearing: true },
    model: { type: 'string', default: 'opus' },
    timeoutMs: { type: 'integer', default: 180000 },
    machine: { type: 'string', machine: true, description: 'the machine that runs claude' },
  },
  required: ['machine'],
};
const LEVELS = [
  { name: 'opus', plugin: 'claude-cli', options: { model: 'opus', machine: 'local' } },
  { name: 'fable', plugin: 'claude-cli', options: { model: 'claude-fable-0' } },
];
const MACHINES = [{ value: 'local', description: 'this machine' }, { value: 'box', description: 'ssh machine' }];
const MODELS = [
  { value: 'opus', label: 'Opus 5.5', description: 'complex work' },
  { value: 'fable', label: 'Fable 5.1' },
  { value: 'sonnet', label: 'Sonnet 5.5' },
];
const PLUGINS = {
  roles: ['router', 'escalation-level'],
  config: { source: 'stored', version: 'p1', warnings: [] },
  instances: LEVELS.map((instance) => ({ role: 'escalation-level', instance })),
  router: { instance: { name: 'pass-through', plugin: 'pass-through' }, selection: 'detected', detection: { status: 'available' }, active: 'pass-through', fallback: false },
  escalationLevels: LEVELS.map((instance) => ({ instance, detection: { status: 'available' }, active: 'claude-cli' })),
  executors: { instances: [] }, jobSources: { instances: [] }, machines: { instances: [] }, usageSources: { instances: [] }, notifiers: { instances: [] },
  plugins: [
    { id: 'claude-cli', role: 'escalation-level', describe: 'claude -p', builtin: true, detection: { status: 'available' }, options: claudeSchema, choices: { model: MODELS, machine: MACHINES } },
  ],
  errors: [], warnings: [],
};

interface Call { path: string; method: string; headers: Record<string, string>; body?: Record<string, unknown> }

function fakeDaemon() {
  const calls: Call[] = [];
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', routerMode: 'shadow', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], waitingAnswer: [], ended: [] },
    '/api/machines': { machines: [] },
    '/api/decisions': { decisions: [] },
    '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] },
    '/api/webhooks/deliveries': { deliveries: [] },
    '/api/questions': { questions: [] },
    '/api/sources': { sources: [] },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] },
    '/api/accounts': { accounts: [] },
    '/api/plugins': PLUGINS,
    '/api/question-gates': GATES,
  };
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = String(input).split('?')[0]!;
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ path, method: init.method ?? 'GET', headers, ...(body ? { body } : {}) });
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'admin', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (path === '/ui/api/rules') return json(200, { ...RULES, text: body!.text, version: 'v2' });
    if (path === '/ui/api/plugins') return json(200, PLUGINS);
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

async function boot(o: { keepStorage?: boolean } = {}) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#settings/questions';
  if (!o.keepStorage) localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const daemon = fakeDaemon();
  vi.stubGlobal('fetch', daemon.fetch);
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(rulesBox()).not.toBeNull());
  return daemon;
}

const panel = () => document.querySelector('[data-slot="question-gates"]');
const rulesBox = () => panel()?.querySelector<HTMLTextAreaElement>('textarea[name="rules"]') ?? null;
const button = (label: string) => [...panel()!.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
const click = (b: HTMLElement | undefined) => act(async () => { b!.click(); });
const type = (box: HTMLTextAreaElement, text: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, text);
  box.dispatchEvent(new Event('input', { bubbles: true }));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('question gates panel', () => {
  it('shows the chain, the risk rules read-only, and the rules', async () => {
    await boot();
    const text = panel()!.textContent!;
    for (const s of ['Escalation levels', 'Risk rules', 'Owner', 'opus', 'fable', 'delete', 'deploying or publishing', 'Standing rules']) expect(text).toContain(s);
    expect(rulesBox()!.value).toBe(RULES.text);
  });

  it('Save posts the draft with the version it was based on', async () => {
    const daemon = await boot();
    await type(rulesBox()!, '- never force-push\n');
    await click(button('Save rules'));
    await vi.waitFor(() => expect(daemon.calls.some((c) => c.path === '/ui/api/rules')).toBe(true));
    const call = daemon.calls.find((c) => c.path === '/ui/api/rules')!;
    expect(call.method).toBe('POST');
    expect(call.headers['x-hopper-session']).toBe('a'.repeat(64));
    expect(call.body).toEqual({ text: '- never force-push\n', version: 'v1' });
  });

  it('an unsaved draft survives a reload; Discard drops it', async () => {
    await boot();
    await type(rulesBox()!, 'half-written\n');
    await act(async () => root?.unmount());
    await boot({ keepStorage: true });
    expect(rulesBox()!.value).toBe('half-written\n');
    await click(button('Discard'));
    await vi.waitFor(() => expect(rulesBox()!.value).toBe(RULES.text));
  });

  const pluginsCall = (daemon: { calls: Call[] }) => daemon.calls.find((c) => c.path === '/ui/api/plugins')?.body;

  const levelForm = (name: string) => panel()!.querySelector(`[data-slot="instance-form"][data-instance="${name}"]`)!;

  it('a level\'s model is a choice of the models the plugin lists; a configured model it does not list stays shown', async () => {
    await boot();
    const opus = levelForm('opus');
    expect(opus.querySelector('input[name="model"]')).toBeNull();
    const select = opus.querySelector<HTMLSelectElement>('select[name="model"]')!;
    expect(select.value).toBe('opus');
    expect([...select.options].map((o) => o.value)).toEqual(['', 'opus', 'fable', 'sonnet']);
    expect(select.textContent).toContain('Opus 5.5');
    const fable = levelForm('fable').querySelector<HTMLSelectElement>('select[name="model"]')!;
    expect(fable.value).toBe('claude-fable-0');
    expect([...fable.options].find((o) => o.value === 'claude-fable-0')!.textContent).toContain('not listed');
  });

  it('a chosen model is saved as the level\'s option', async () => {
    const daemon = await boot();
    const select = levelForm('opus').querySelector<HTMLSelectElement>('select[name="model"]')!;
    await act(async () => {
      select.value = 'sonnet';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click(button('Save opus'));
    await vi.waitFor(() => expect(pluginsCall(daemon)).toBeDefined());
    expect(pluginsCall(daemon)).toEqual({ action: 'options', role: 'escalation-level', name: 'opus', options: { model: 'sonnet', machine: 'local' }, version: 'p1' });
  });

  it('a level moves earlier or later through POST /ui/api/plugins', async () => {
    const daemon = await boot();
    expect(panel()!.querySelector('button[aria-label="Move opus later"]')).not.toBeNull();
    expect(panel()!.querySelector('button[aria-label="Move opus earlier"]')).toBeNull();
    await click(panel()!.querySelector<HTMLButtonElement>('button[aria-label="Move fable earlier"]')!);
    await vi.waitFor(() => expect(pluginsCall(daemon)).toBeDefined());
    expect(pluginsCall(daemon)).toEqual({ action: 'move', role: 'escalation-level', name: 'fable', to: 0, version: 'p1' });
  });

  const pick = (select: HTMLSelectElement, value: string) => act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });

  it('a level is added on top under the name typed, on the machine picked: Add waits for the machine (#174)', async () => {
    const daemon = await boot();
    const name = panel()!.querySelector<HTMLInputElement>('input[name="add-name-escalation-level"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'sonnet');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const machine = panel()!.querySelector<HTMLSelectElement>('select[name="add-machine-escalation-level"]')!;
    expect([...machine.options].filter((o) => !o.disabled).map((o) => o.value)).toEqual(['local', 'box']);
    expect(button('Add')!.disabled).toBe(true);
    await pick(machine, 'box');
    await click(button('Add'));
    await vi.waitFor(() => expect(pluginsCall(daemon)).toBeDefined());
    expect(pluginsCall(daemon)).toEqual({ action: 'add', role: 'escalation-level', plugin: 'claude-cli', name: 'sonnet', options: { machine: 'box' }, version: 'p1' });
  });

  it('a level\'s machine is picked from the configured machines, never typed, and never left empty (#174)', async () => {
    const daemon = await boot();
    const opus = levelForm('opus');
    expect(opus.querySelector('input[name="machine"]')).toBeNull();
    const select = opus.querySelector<HTMLSelectElement>('select[name="machine"]')!;
    expect(select.value).toBe('local');
    expect([...select.options].filter((o) => !o.disabled).map((o) => o.value)).toEqual(['local', 'box']);
    // A level that names none shows it must be picked; it offers no empty choice.
    const fable = levelForm('fable').querySelector<HTMLSelectElement>('select[name="machine"]')!;
    expect(fable.value).toBe('');
    expect([...fable.options].find((o) => o.value === '')!.disabled).toBe(true);
    expect(fable.textContent).toContain('pick a machine');
    await pick(fable, 'box');
    await click(button('Save fable'));
    await vi.waitFor(() => expect(pluginsCall(daemon)).toBeDefined());
    expect(pluginsCall(daemon)).toEqual({ action: 'options', role: 'escalation-level', name: 'fable', options: { model: 'claude-fable-0', machine: 'box' }, version: 'p1' });
  });
});
