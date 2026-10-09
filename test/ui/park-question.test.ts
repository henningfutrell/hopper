// @vitest-environment happy-dom
// Issue #530: Park where a person decides a job must wait — on its question card — and for a job whose executor
// recorded no agent session (one started before #510). Its re-queue says it starts a fresh session in the kept work
// tree, with the question and its answer as context, and asks first; a job whose executor cannot park says why.
// The whole app against a fake of the daemon's HTTP surface and a fake SSE, as questions.test.ts.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../../src/domain/types.ts';

const at = '2026-10-09T08:00:00.000Z';
const job = (id: string, o: Partial<Job>): Job => ({
  id, spec: { executor: 'herdr-claude', payload: { prompt: `Task ${id}` } }, priority: 50, status: 'waiting_answer', approved: false, attempts: 1,
  createdAt: at, updatedAt: at, ...o,
} as Job);
const question = (id: string, jobId: string) => ({
  id, jobId, text: `Question of ${jobId}`, recentOutput: 'line', detectedBy: 'marker', status: 'open', tier: 'human', attempts: [], notifyCount: 1,
  createdAt: at, updatedAt: at,
});

interface Call { path: string; method: string; body?: unknown }

function fakeDaemon(o: { waitingAnswer?: Job[]; parked?: Job[]; questions?: unknown[] }) {
  const calls: Call[] = [];
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: ['test', 'herdr-claude'], parkingExecutors: ['herdr-claude'], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], operatorLed: [], parked: o.parked ?? [], waitingAnswer: o.waitingAnswer ?? [], ended: [], locked: [] },
    '/api/machines': { machines: [] }, '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] }, '/api/sources': { sources: [] },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
    '/api/questions': { questions: o.questions ?? [] },
  };
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = String(input).split('?')[0]!;
    calls.push({ path, method: init.method ?? 'GET', ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (path === '/ui/api/session') {
      return json({ authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'operator', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    }
    if (path.startsWith('/ui/api/')) return json({});
    return path in routes ? json(routes[path]) : new Response('{"error":"not found"}', { status: 404 });
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

async function boot(hash: string, o: Parameters<typeof fakeDaemon>[0]) {
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
  return daemon;
}

const card = (text: string) => [...document.querySelectorAll('[data-slot="card"]')].find((c) => c.textContent?.includes(text)) ?? null;
const button = (label: string, within: ParentNode) => [...within.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
const dialog = () => vi.waitFor(() => { const d = document.querySelector('[role="alertdialog"]'); expect(d).not.toBeNull(); return d!; });
const click = (b: HTMLElement | undefined) => act(async () => { b!.click(); });

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('Park on the question card (issue #530)', () => {
  it('is offered for a job on the question with no agent session, and asks before it parks it', async () => {
    const daemon = await boot('#questions', { waitingAnswer: [job('j1', { questionId: 'q1' })], questions: [question('q1', 'j1')] });
    const c = await vi.waitFor(() => { const x = card('Question of j1'); expect(x && button('Park', x)).toBeDefined(); return x!; });
    await click(button('Park', c));
    expect(daemon.calls.some((x) => x.path === '/ui/api/jobs/j1/park')).toBe(false);
    await click(button('Park job', await dialog()));
    await vi.waitFor(() => expect(daemon.calls.find((x) => x.path === '/ui/api/jobs/j1/park')?.method).toBe('POST'));
  });

  it('a job whose executor cannot park says why on its card, instead of a missing button', async () => {
    await boot('#questions', { waitingAnswer: [job('j2', { questionId: 'q2', spec: { executor: 'test', payload: {} } })], questions: [question('q2', 'j2')] });
    const c = await vi.waitFor(() => { const x = card('Question of j2'); expect(x?.querySelector('[data-slot="park-refusal"]')).not.toBeNull(); return x!; });
    expect(button('Park', c)).toBeUndefined();
    expect(c.querySelector('[data-slot="park-refusal"]')!.textContent).toContain('executor test cannot park');
  });
});

describe('Re-queue of a parked job (issue #530)', () => {
  const row = (id: string) => document.querySelector<HTMLElement>(`[data-job-group="parked"][data-job-id="${id}"]`);

  it('with no agent session: says it starts a fresh session in the kept work tree with the question and answer, and asks first', async () => {
    const daemon = await boot('#overview', { parked: [job('p1', { status: 'parked', questionId: 'q9', resumeOn: 'local', parked: { at, from: 'waiting_answer' } })] });
    const r = await vi.waitFor(() => { const x = row('p1'); expect(x && button('Re-queue', x)).toBeDefined(); return x!; });
    await click(button('Re-queue', r));
    const d = await dialog();
    expect(d.textContent).toMatch(/fresh/i);
    expect(d.textContent).toMatch(/work tree/);
    expect(d.textContent).toMatch(/question/);
    expect(daemon.calls.some((x) => x.path === '/ui/api/jobs/p1/requeue')).toBe(false);
    await click([...d.querySelectorAll('button')].find((b) => /start fresh/i.test(b.textContent ?? '')));
    await vi.waitFor(() => expect(daemon.calls.find((x) => x.path === '/ui/api/jobs/p1/requeue')?.body).toEqual({ freshSession: true }));
  });

  it('with its agent session: re-queued at once, resuming it', async () => {
    const daemon = await boot('#overview', { parked: [job('p2', { status: 'parked', agentSession: 's', resumeOn: 'local', parked: { at, from: 'running' } })] });
    const r = await vi.waitFor(() => { const x = row('p2'); expect(x && button('Re-queue', x)).toBeDefined(); return x!; });
    await click(button('Re-queue', r));
    await vi.waitFor(() => expect(daemon.calls.find((x) => x.path === '/ui/api/jobs/p2/requeue')?.body).toEqual({}));
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });
});
