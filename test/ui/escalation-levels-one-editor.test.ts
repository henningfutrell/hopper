// @vitest-environment happy-dom
// Issue #444: the escalation levels are edited in one place, Settings → Question gates. The Plugins section
// shows them read-only, in order and with their state, and links to that editor; it offers no Add, Save,
// Move, Remove or switch for a level. Rendered in happy-dom inside the whole app against a fake of the
// daemon's HTTP surface that keeps the plugins config, so an edit made in Question gates shows in the
// Plugins summary after it reloads.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const claudeSchema = {
  type: 'object',
  properties: { model: { type: 'string', default: 'opus' }, machine: { type: 'string', machine: true } },
  required: ['machine'],
};
const MACHINES = [{ value: 'local', description: 'this machine' }];

interface Level { name: string; plugin: string; options?: Record<string, unknown> }

function reportOf(levels: Level[], version: string) {
  return {
    roles: ['escalation-level', 'executor'],
    config: { source: 'stored', version, warnings: [] },
    instances: [
      ...levels.map((instance) => ({ role: 'escalation-level', instance })),
      { role: 'executor', instance: { name: 'test', plugin: 'test' } },
    ],
    router: { instance: { name: 'pass-through', plugin: 'pass-through' }, selection: 'detected', detection: { status: 'available' }, active: 'pass-through', fallback: false },
    escalationLevels: levels.map((instance) => ({ instance, detection: { status: 'available' }, active: 'claude-cli' })),
    executors: { instances: [{ instance: { name: 'test', plugin: 'test' }, detection: { status: 'available' }, active: 'test' }] },
    jobSources: { instances: [] }, machines: { instances: [] }, usageSources: { instances: [] }, notifiers: { instances: [] }, vaultBackends: { instances: [] },
    plugins: [
      { id: 'claude-cli', role: 'escalation-level', describe: 'claude -p', builtin: true, detection: { status: 'available' }, options: claudeSchema, choices: { machine: MACHINES } },
      { id: 'anthropic-api', role: 'escalation-level', describe: 'the API', builtin: true, detection: { status: 'available' }, options: {} },
      { id: 'test', role: 'executor', describe: 'test', builtin: true, detection: { status: 'available' }, options: {} },
      { id: 'cursor-agent', role: 'executor', describe: 'cursor', builtin: true, detection: { status: 'available' }, options: {} },
    ],
    errors: [], warnings: [],
  };
}

function fakeDaemon() {
  let levels: Level[] = [
    { name: 'level-1', plugin: 'claude-cli', options: { machine: 'local' } },
    { name: 'level-2', plugin: 'claude-cli', options: { model: 'fable', machine: 'local' } },
  ];
  let version = 1;
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [], locked: [] },
    '/api/machines': { machines: [] }, '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] }, '/api/questions': { questions: [] },
    '/api/sources': { sources: [] }, '/api/accounts': { accounts: [] },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] },
    '/api/question-gates': { rules: { text: '', version: 'missing', missing: true }, riskRules: [] },
    '/api/plugin-store': { sources: [], plugins: [] },
  };
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = String(input).split('?')[0]!;
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'admin', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (path === '/api/plugins') return json(200, reportOf(levels, `p${version}`));
    if (path === '/ui/api/plugins' && body?.action === 'move') {
      const moved = levels.find((l) => l.name === body.name)!;
      levels = levels.filter((l) => l !== moved);
      levels.splice(Number(body.to), 0, moved);
      version += 1;
      return json(200, reportOf(levels, `p${version}`));
    }
    if (path in routes) return json(200, routes[path]);
    return json(404, { error: 'not found' });
  });
  return { fetch };
}

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

let root: Root | undefined;

async function boot(hash: string) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = hash;
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', fakeDaemon().fetch);
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
}

const go = (hash: string) => act(async () => {
  window.location.hash = hash;
  window.dispatchEvent(new HashChangeEvent('hashchange'));
});
const summary = () => document.querySelector('[data-slot="escalation-levels-summary"]');
const levelForms = () => document.querySelectorAll('[data-slot="instance-form"][data-instance^="level-"]');
const buttons = (label: RegExp) => [...document.querySelectorAll('button')].filter((b) => label.test(b.getAttribute('aria-label') ?? b.textContent ?? ''));

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('escalation levels have one editor (issue #444)', () => {
  it('Plugins shows the levels read-only, in order, with a link to Question gates; no level edit control', async () => {
    await boot('#settings/plugins');
    await vi.waitFor(() => expect(summary()).not.toBeNull());
    const items = [...summary()!.querySelectorAll('[data-level]')].map((e) => e.getAttribute('data-level'));
    expect(items).toEqual(['level-1', 'level-2']);
    expect(summary()!.textContent).toContain('active');
    expect(summary()!.querySelector('a[href="#settings/questions"]')).not.toBeNull();
    expect(levelForms()).toHaveLength(0);
    expect(document.querySelector('select[name="add-plugin-escalation-level"]')).toBeNull();
    expect(buttons(/level-|claude-cli|anthropic-api/)).toEqual([]);
    expect(document.querySelector('[role="switch"][aria-label$="claude-cli"]')).toBeNull();
    expect(document.querySelector('[role="switch"][aria-label$="anthropic-api"]')).toBeNull();
    // The other list roles keep their editors and switches.
    expect(document.querySelector('select[name="add-plugin-executor"]')).not.toBeNull();
    expect(document.querySelector('[role="switch"][aria-label="Enable cursor-agent"]')).not.toBeNull();
  });

  it('Question gates is where levels are edited', async () => {
    await boot('#settings/questions');
    await vi.waitFor(() => expect(levelForms()).toHaveLength(2));
    expect(document.querySelector('select[name="add-plugin-escalation-level"]')).not.toBeNull();
    expect(summary()).toBeNull();
  });

  it('a level moved in Question gates shows in the new order in the Plugins summary', async () => {
    await boot('#settings/questions');
    await vi.waitFor(() => expect(levelForms()).toHaveLength(2));
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="Move level-2 earlier"]')!.click(); });
    await vi.waitFor(() => expect([...levelForms()].map((e) => e.getAttribute('data-instance'))).toEqual(['level-2', 'level-1']));
    await go('#settings/plugins');
    await vi.waitFor(() => expect(summary()).not.toBeNull());
    expect([...summary()!.querySelectorAll('[data-level]')].map((e) => e.getAttribute('data-level'))).toEqual(['level-2', 'level-1']);
  });
});
