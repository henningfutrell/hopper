// @vitest-environment happy-dom
// The Question gates panel in the Questions view (issue #18), rendered in happy-dom inside the whole
// app against a fake of the daemon's HTTP surface. It shows the chain a question goes through, lets
// The owner pick the answerer (or none) and the assessor through POST /ui/api/plugins, and edits the
// rules file through POST /ui/api/rules-file with the version the draft was based on. An unsaved
// draft survives a reload.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const RULES = { path: '/home/h/.config/job-hopper/rules.md', text: '- prefer small PRs\n', version: 'v1', missing: false };
const GATES = {
  rulesFile: RULES,
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
  },
};
const PLUGINS = {
  roles: ['router', 'answerer', 'assessor'],
  config: { path: '/home/h/.config/job-hopper/plugins.yaml', source: 'file', version: 'p1', warnings: [] },
  instances: [
    { role: 'answerer', instance: { name: 'opus', plugin: 'claude-cli', options: { model: 'opus' } } },
    { role: 'assessor', instance: { name: 'fable', plugin: 'claude-cli-assessor', options: { model: 'fable' } } },
  ],
  router: { instance: { name: 'pass-through', plugin: 'pass-through' }, selection: 'detected', detection: { status: 'available' }, active: 'pass-through', fallback: false },
  answerer: { instance: { name: 'opus', plugin: 'claude-cli', options: { model: 'opus' } }, detection: { status: 'available' }, active: 'claude-cli', fallback: false },
  assessor: { instance: { name: 'fable', plugin: 'claude-cli-assessor', options: { model: 'fable' } }, detection: { status: 'available' }, active: 'claude-cli-assessor', fallback: false },
  executors: { instances: [] }, jobSources: { instances: [] }, machines: { instances: [] }, usageSources: { instances: [] }, notifiers: { instances: [] },
  plugins: [
    { id: 'claude-cli', role: 'answerer', describe: 'claude -p', builtin: true, detection: { status: 'available' }, options: claudeSchema },
    { id: 'claude-cli-assessor', role: 'assessor', describe: 'claude -p', builtin: true, detection: { status: 'available' }, options: claudeSchema },
    { id: 'always-escalate', role: 'assessor', describe: 'always', builtin: true, detection: { status: 'available' }, options: { type: 'object', properties: {} } },
  ],
  errors: [], warnings: [],
};

interface Call { path: string; method: string; headers: Record<string, string>; body?: Record<string, unknown> }

function fakeDaemon() {
  const calls: Call[] = [];
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', routerMode: 'shadow', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], waitingAnswer: [], ended: [], counts: {} },
    '/api/machines': { machines: [] },
    '/api/decisions': { decisions: [] },
    '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] },
    '/api/webhooks/deliveries': { deliveries: [] },
    '/api/questions': { questions: [] },
    '/api/sources': { sources: [] },
    '/api/plugins': PLUGINS,
    '/api/question-gates': GATES,
  };
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = String(input).split('?')[0]!;
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ path, method: init.method ?? 'GET', headers, ...(body ? { body } : {}) });
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z' });
    if (path === '/ui/api/rules-file') return json(200, { ...RULES, text: body!.text, version: 'v2' });
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
  window.location.hash = '#questions';
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
const rulesBox = () => panel()?.querySelector<HTMLTextAreaElement>('textarea[name="rules-file"]') ?? null;
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
  it('shows the chain, the risk rules read-only, and the rules file', async () => {
    await boot();
    const text = panel()!.textContent!;
    for (const s of ['Answerer', 'Assessor', 'Risk rules', 'the owner', 'opus', 'fable', 'delete', 'deploying or publishing', RULES.path]) expect(text).toContain(s);
    expect(rulesBox()!.value).toBe(RULES.text);
  });

  it('Save posts the draft with the version it was based on', async () => {
    const daemon = await boot();
    await type(rulesBox()!, '- never force-push\n');
    await click(button('Save rules'));
    await vi.waitFor(() => expect(daemon.calls.some((c) => c.path === '/ui/api/rules-file')).toBe(true));
    const call = daemon.calls.find((c) => c.path === '/ui/api/rules-file')!;
    expect(call.method).toBe('POST');
    expect(call.headers['x-jobhopper-session']).toBe('a'.repeat(64));
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

  it('the answerer can be set to none through the plugins select', async () => {
    const daemon = await boot();
    const select = panel()!.querySelector<HTMLSelectElement>('select[name="plugin-answerer"]')!;
    await act(async () => { select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await click(button('Use'));
    await vi.waitFor(() => expect(daemon.calls.some((c) => c.path === '/ui/api/plugins')).toBe(true));
    expect(daemon.calls.find((c) => c.path === '/ui/api/plugins')!.body).toEqual({ action: 'select', role: 'answerer', plugin: null, version: 'p1' });
  });
});
