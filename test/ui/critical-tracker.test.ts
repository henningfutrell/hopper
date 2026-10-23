// @vitest-environment happy-dom
// The critical job tracker (issue #2203), rendered in happy-dom inside the whole app against a fake of the daemon's HTTP
// surface: a job at the critical priority shows in a widget on every page, through navigation and a reload, with where it
// runs, its current step and its last actions; it updates live from the event stream; each wait that is a person's is
// acted on in the widget, by the route of its one home (the run card's, the vault grant's, the question's, the job's own
// wait's, a hold's); a job that needs a person turns the widget red; an ended one stays until it is dismissed, and the
// dismissal holds after a reload. Compact (issue #2261): one row per job until a person opens it, the ended ones folded
// behind their count.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const at = '2026-10-19T10:00:00.000Z';
const job = (id: string, o: Record<string, unknown> = {}) => ({
  id, spec: { executor: 'herdr-claude', payload: {}, goal: `Fix ${id}` }, priority: 100, status: 'running', approved: false,
  createdAt: at, updatedAt: at, attempts: 1, laneId: 'm1/lane-1', ...o,
});

interface Daemon { queue: Record<string, unknown>; questions: unknown[]; vault: Record<string, unknown>; events: unknown[] }
let daemon: Daemon;
const posts: { path: string; body: unknown }[] = [];

const EMPTY_QUEUE = { waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], waitingOn: [], ended: [], locked: [], highPriority: 75, criticalPriority: 100 };
const VAULT = { secrets: [], templates: [], requests: [], runs: [], grantAsks: [], sandboxRequests: [] };

function fakeFetch() {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const routes = (): Record<string, unknown> => ({
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': daemon.queue, '/api/questions': { questions: daemon.questions }, '/api/vault': daemon.vault, '/api/events': { events: daemon.events },
    '/api/machines': { machines: [{ id: 'm1', label: 'laptop', maxLanes: 2, online: true, executors: ['herdr-claude'], lanes: [], usage: [] }] },
    '/api/decisions': { decisions: [] }, '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] }, '/api/sources': { sources: [] },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
  });
  return vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input).split('?')[0]!;
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'admin', realm: 'local', name: 'admin', instanceAdmin: true }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (init?.method === 'POST') {
      posts.push({ path, body: JSON.parse(String(init.body)) as unknown });
      if (path.endsWith('/grant-vault') || path === '/ui/api/sandbox-requests') return json(200, daemon.vault);
      return json(200, { ok: true });
    }
    const r = routes();
    return path in r ? json(200, r[path]) : json(404, { error: 'not found' });
  });
}

class FakeEventSource {
  static last: FakeEventSource | undefined;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly listeners = new Map<string, ((m: { data: string }) => void)[]>();
  constructor() { FakeEventSource.last = this; }
  addEventListener(type: string, fn: (m: { data: string }) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  emit(type: string, data: unknown): void { for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) }); }
  close(): void {}
}

let root: Root | undefined;

/** Starts the app at `hash`, as a page load: `keep` keeps what this browser stored (a reload). */
async function boot(hash = '#dashboard', keep = false) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => root?.unmount());
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = hash;
  if (!keep) localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', fakeFetch());
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(document.querySelector('[data-slot="needs-you"], [data-slot="dashboard"], main')).not.toBeNull());
}

const tracker = () => document.querySelector<HTMLElement>('[data-slot="critical-tracker"]');
const card = (id: string) => tracker()?.querySelector<HTMLElement>(`[data-slot="critical-job"][data-job-id="${id}"]`) ?? null;
const wait = (id: string, kind: string) => card(id)?.querySelector<HTMLElement>(`[data-slot="critical-wait"][data-wait="${kind}"]`) ?? null;
const button = (label: string, within: ParentNode = document) => [...within.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
const click = (b: HTMLElement | undefined) => act(async () => { b!.click(); });
/** Opens a job's row: its detail shows only when a person opens it (issue #2261). */
const expand = (id: string) => click(card(id)!.querySelector<HTMLElement>('[data-slot="critical-row"]')!);
const navigate = (hash: string) => act(async () => { window.location.hash = hash; window.dispatchEvent(new HashChangeEvent('hashchange')); });

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  posts.length = 0;
  vi.unstubAllGlobals();
});

describe('the critical job tracker', () => {
  it('shows a critical job on every page, through navigation and a reload, with where it runs and what it does', async () => {
    daemon = {
      queue: { ...EMPTY_QUEUE, running: [job('crit')], waiting: [job('plain', { priority: 75, status: 'queued' })] },
      questions: [], vault: { ...VAULT, sandboxRequests: [{ id: 'sr1', jobId: 'crit', template: 'kubectl-diag', state: 'approved', askedAt: at }] },
      events: [{ seq: 1, type: 'job.started', jobId: 'crit', at, data: {} }],
    };
    await boot('#dashboard');
    await vi.waitFor(() => expect(card('crit')).not.toBeNull());
    expect(card('plain')).toBeNull();
    expect(card('crit')!.textContent).toContain('Fix crit');
    // Collapsed by default: one row, the title once, no detail.
    expect(card('crit')!.textContent!.split('Fix crit').length).toBe(2);
    expect(card('crit')!.querySelector('[data-slot="critical-where"]')).toBeNull();
    await expand('crit');
    await vi.waitFor(() => expect(card('crit')!.querySelector('[data-slot="critical-where"]')!.textContent).toContain('sandbox kubectl-diag'));
    expect(card('crit')!.querySelector('[data-slot="critical-where"]')!.textContent).toContain('laptop');
    expect(card('crit')!.querySelector('[data-slot="critical-actions"]')).not.toBeNull();
    expect(tracker()!.dataset.needsPerson).toBe('false');
    for (const hash of ['#questions', '#settings', '#machines']) {
      await navigate(hash);
      expect(card('crit'), hash).not.toBeNull();
    }
    await boot('#access-requests', true);
    await vi.waitFor(() => expect(card('crit')).not.toBeNull());
  });

  it('updates live: a job raised to the critical priority shows without a reload', async () => {
    daemon = { queue: { ...EMPTY_QUEUE, waiting: [job('later', { priority: 50, status: 'queued' })] }, questions: [], vault: VAULT, events: [] };
    await boot('#dashboard');
    await vi.waitFor(() => expect(document.querySelector('main')).not.toBeNull());
    expect(tracker()).toBeNull();
    daemon.queue = { ...EMPTY_QUEUE, waiting: [job('later', { status: 'queued' })] };
    await act(async () => { FakeEventSource.last!.emit('job.reprioritized', { seq: 5, type: 'job.reprioritized', jobId: 'later', at, data: {} }); });
    await vi.waitFor(() => expect(card('later')).not.toBeNull(), { timeout: 5000 });
  });

  it('acts on each wait in the widget, by the route of its one home, and goes red while one waits', async () => {
    daemon = {
      queue: { ...EMPTY_QUEUE, waitingAnswer: [job('asks', { status: 'waiting_answer', questionId: 'q1' })], waitingOn: [job('waits', { status: 'waiting_on', wait: { for: 'nodes to go Ready', since: at } })], waiting: [job('held', { status: 'held', holdReason: 'ask_human: a risky change' })], running: [job('box')] },
      questions: [{ id: 'q1', jobId: 'asks', text: 'Which cluster do I reboot?', status: 'open', tier: 'human', createdAt: at, recentOutput: '', attempts: [], priority: 100, high: true, notifyCount: 1 }],
      vault: { ...VAULT, runs: [{ jobId: 'box', template: 'kubectl-diag', askedAt: at, waits: { template: false, run: true }, purpose: 'reboot a node' }], grantAsks: [{ job: 'box', key: 'k1', names: ['DB_URL'], askedAt: at }] },
      events: [],
    };
    await boot('#machines');
    await vi.waitFor(() => expect(card('box')).not.toBeNull());
    expect(tracker()!.dataset.needsPerson).toBe('true');
    // The collapsed row has the first wait's action: Continue ends the job's own wait from the row.
    expect(wait('waits', 'wait')).toBeNull();
    await click(button('Continue', card('waits')!));
    await vi.waitFor(() => expect(posts.map((p) => p.path)).toContain('/ui/api/jobs/waits/end-wait'));
    posts.length = 0;
    // An action that opens a card opens the row with that card in place.
    await click(button('Approve', card('box')!));
    expect(wait('box', 'run')!.querySelector('[data-slot="critical-wait-card"]')).not.toBeNull();
    for (const id of ['waits', 'asks', 'held']) await expand(id);
    expect(card('waits')!.querySelector('[data-slot="critical-step"]')!.textContent).toContain('waits for nodes to go Ready');

    // The run card: its own card opens in the widget, and its Approve approves the run, as Access requests does.
    await click(button('Approve', wait('box', 'run')!.querySelector('[data-run-card]')!));
    await click(button('Approve', document.querySelector('[role="alertdialog"]')!));
    await vi.waitFor(() => expect(posts).toContainEqual({ path: '/ui/api/sandbox-requests', body: { action: 'approve-run', job: 'box', template: 'kubectl-diag' } }));

    await click(button('Grant', wait('box', 'grant')!));
    await vi.waitFor(() => expect(posts.map((p) => p.path)).toContain('/ui/api/jobs/box/grant-vault'));

    await click(button('Approve', wait('held', 'hold')!));
    await vi.waitFor(() => expect(posts.map((p) => p.path)).toContain('/ui/api/jobs/held/approve'));

    await click(button('Continue', wait('waits', 'wait')!));
    await vi.waitFor(() => expect(posts.map((p) => p.path)).toContain('/ui/api/jobs/waits/end-wait'));

    // The question: the Questions page's own card, in the widget, sends the answer by its route.
    await click(button('Answer', wait('asks', 'question')!));
    const box = wait('asks', 'question')!.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'the second one');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button('Send answer', wait('asks', 'question')!));
    await vi.waitFor(() => expect(posts).toContainEqual({ path: '/ui/api/questions/q1/answer', body: { answer: 'the second one' } }));
  });

  it('a parked critical direct job\'s question is in Questions and its badge too, and an answer clears it from both (issue #2634)', async () => {
    const parked = job('dq', {
      status: 'parked', questionId: 'q7', laneId: undefined, resumeOn: 'm1', parked: { at, from: 'waiting_answer', auto: true },
      source: { source: 'direct', kind: 'direct', key: 'direct:d7', title: 'Why did the sign-in lock?' },
    });
    const q = { id: 'q7', jobId: 'dq', text: 'Which realm do I check first?', status: 'open', tier: 'human', createdAt: at, recentOutput: '', attempts: [], priority: 100, high: true, notifyCount: 1 };
    daemon = { queue: { ...EMPTY_QUEUE, parked: [parked] }, questions: [q], vault: VAULT, events: [] };
    await boot('#questions');
    await vi.waitFor(() => expect(card('dq')).not.toBeNull());
    await expand('dq');
    expect(wait('dq', 'question')).not.toBeNull();
    await vi.waitFor(() => expect(document.querySelector('[data-question="q7"]')).not.toBeNull());
    const badge = () => [...document.querySelectorAll('[data-slot="nav-badge"]')].find((b) => b.closest('a')?.getAttribute('href') === '#questions');
    expect(badge()!.getAttribute('title')).toBe('1 question waits on you; 1 high priority');

    // Answered, it leaves the open questions, as the daemon lists them.
    daemon.questions = [];
    await click(button('Answer', wait('dq', 'question')!));
    const box = wait('dq', 'question')!.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'the local one');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button('Send answer', wait('dq', 'question')!));
    await vi.waitFor(() => expect(posts).toContainEqual({ path: '/ui/api/questions/q7/answer', body: { answer: 'the local one' } }));
    await vi.waitFor(() => expect(document.querySelector('[data-question="q7"]')).toBeNull());
    expect(wait('dq', 'question')).toBeNull();
  });

  it('keeps an ended job until a person dismisses it, and the dismissal holds after a reload', async () => {
    daemon = { queue: { ...EMPTY_QUEUE, ended: [job('done', { status: 'finished', finishedAt: at })], running: [job('live')] }, questions: [], vault: VAULT, events: [] };
    await boot('#dashboard');
    await vi.waitFor(() => expect(card('live')).not.toBeNull());
    // An ended job folds behind its count: the panel shows the jobs that need attention.
    expect(card('done')).toBeNull();
    await click(button('1 ended', tracker()!));
    await vi.waitFor(() => expect(card('done')).not.toBeNull());
    // A job that has not ended has no Dismiss: it shows until it ends.
    expect(card('live')!.querySelector('button[aria-label="Dismiss"]')).toBeNull();
    await click(card('done')!.querySelector<HTMLElement>('button[aria-label="Dismiss"]')!);
    expect(card('done')).toBeNull();
    await boot('#dashboard', true);
    await vi.waitFor(() => expect(card('live')).not.toBeNull());
    expect(card('done')).toBeNull();
    expect(button('1 ended', tracker()!)).toBeUndefined();
  });
});
