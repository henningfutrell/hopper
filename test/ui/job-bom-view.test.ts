// @vitest-environment happy-dom
// Issue #935: the drill-in job page (#job/<id>), rendered inside the whole app against a fake of the daemon's HTTP
// surface, its parts list made by the real jobBom. A plain-words header (what was asked, where it stands, what is next);
// what waits on the person pinned at the top; the job's own graph with a node per part; the timeline, newest first; the
// parts list as a table filtered by group and text. A new event of the job reads the parts again, with no reload.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jobBom } from '../../src/domain/job-bom.ts';
import type { DomainEvent, Job, Question } from '../../src/domain/types.ts';

const ISSUE = 'https://github.com/acme/app/issues/7';
const PR = 'https://github.com/acme/app/pull/12';
const job = {
  id: 'j1', spec: { executor: 'test', payload: {}, goal: 'Make the cache faster' }, priority: 50, status: 'waiting_answer', approved: true, attempts: 1,
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T01:00:00.000Z', questionId: 'q1',
  source: { source: 'github', kind: 'issue', key: ISSUE, url: ISSUE, repo: 'acme/app', number: 7, title: 'Make the cache faster' },
  sourceState: { source: { pullRequest: PR, follow: 'open', seen: { checks: 'pending' } } },
} as unknown as Job;
const question = { id: 'q1', jobId: 'j1', text: 'Which store?', status: 'open', tier: 'human', attempts: [], createdAt: '2026-10-01T00:30:00.000Z' } as unknown as Question;
const event = (seq: number, type: string): DomainEvent => ({ seq, schemaVersion: 1, id: `e${seq}`, type, at: `2026-10-01T00:0${seq}:00.000Z`, jobId: 'j1', data: {} } as DomainEvent);

let events: DomainEvent[] = [];
let bomReads = 0;

function fakeDaemon() {
  const routes: Record<string, () => unknown> = {
    '/api/health': () => ({ ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 }),
    '/api/queue': () => ({ waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [job], ended: [], locked: [] }),
    '/api/machines': () => ({ machines: [] }), '/api/decisions': () => ({ decisions: [] }), '/api/events': () => ({ events: [] }),
    '/api/webhooks': () => ({ subscriptions: [] }), '/api/webhooks/deliveries': () => ({ deliveries: [] }),
    '/api/questions': () => ({ questions: [] }), '/api/sources': () => ({ sources: [] }),
    '/api/usage': () => ({ readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }), '/api/accounts': () => ({ accounts: [] }),
    '/api/jobs/j1/bom': () => { bomReads += 1; return jobBom({ job, events, questions: [question], artifacts: [], related: [], now: '2026-10-01T02:00:00.000Z' }); },
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string) => {
    const path = String(input).split('?')[0]!;
    if (path === '/ui/api/session') return json({ authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'viewer', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    return path in routes ? json(routes[path]!()) : new Response('{"error":"not found"}', { status: 404 });
  });
}

class FakeEventSource {
  static last: FakeEventSource | undefined;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, (m: { data: string }) => void>();
  constructor() { FakeEventSource.last = this; }
  addEventListener(type: string, fn: (m: { data: string }) => void): void { this.listeners.set(type, fn); }
  close(): void {}
  send(e: DomainEvent): void { this.listeners.get(e.type)?.({ data: JSON.stringify(e) }); }
}

let root: Root | undefined;

async function boot() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#job/j1';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', fakeDaemon());
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(document.querySelector('[data-slot="bom-table"]')).not.toBeNull());
}

const text = (slot: string) => document.querySelector<HTMLElement>(`[data-slot="${slot}"]`)?.textContent ?? '';
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-slot="bom-row"]')];

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  events = [];
  bomReads = 0;
  vi.unstubAllGlobals();
});

describe('the drill-in job page (issue #935)', () => {
  it('says what was asked, where it stands and what is next, and pins what waits on the person', async () => {
    await boot();
    expect(text('job-header-asked')).toContain('Make the cache faster (acme/app#7)');
    expect(text('job-header-stands')).toContain('Waiting on you: answer a question');
    expect(text('job-header-next')).toContain('You: answer the question.');
    expect(text('job-summary')).toContain('1 waiting on you');
    const pinned = document.querySelector<HTMLElement>('[data-slot="job-waiting"]')!;
    expect(pinned.textContent).toContain('Which store?');
    expect(pinned.querySelector<HTMLAnchorElement>('a[href="#questions"]')).not.toBeNull();
  });

  it('draws the job\'s own graph with a node per part', async () => {
    await boot();
    const nodes = [...document.querySelectorAll<SVGElement>('[data-slot="bom-graph"] [data-slot="bom-node"]')].map((n) => n.dataset.partId);
    expect(nodes).toEqual(expect.arrayContaining(['question:q1', 'issue:acme/app#7', `pr:${PR}`]));
  });

  it('fits the graph to the panel width by default, with a toggle for actual size (issue #2354)', async () => {
    await boot();
    const svg = () => document.querySelector<SVGSVGElement>('[data-slot="bom-graph"]')!;
    const frame = () => svg().closest<HTMLElement>('[data-slot="fit-graph"]')!;
    expect(svg().getAttribute('viewBox')).toBe(`0 0 ${svg().getAttribute('width')} ${svg().getAttribute('height')}`);
    expect(frame().dataset.size).toBe('fit');
    expect(svg().getAttribute('class')).toMatch(/\bmax-w-full\b/);
    expect(svg().parentElement!.className).not.toMatch(/overflow/);
    await act(async () => { [...frame().querySelectorAll('button')].find((b) => b.textContent === 'Actual size')!.click(); });
    expect(frame().dataset.size).toBe('actual');
    expect(svg().parentElement!.className).toMatch(/overflow-x-auto/);
  });

  it('shows the parts as a table filtered by group and by text', async () => {
    await boot();
    expect(rows()[0]!.dataset.partId).toBe('question:q1');
    const select = document.querySelector<HTMLSelectElement>('[data-slot="bom-filter-group"]')!;
    await act(async () => { select.value = 'code'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(rows().length).toBeGreaterThan(0);
    expect(rows().every((r) => r.dataset.group === 'code')).toBe(true);
    await act(async () => { select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })); });
    const input = document.querySelector<HTMLInputElement>('[data-slot="bom-filter-text"]')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'which');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(rows().map((r) => r.dataset.partId)).toEqual(['question:q1']);
  });

  it('shows the timeline newest first, and reads the parts again when the job has a new event', async () => {
    events = [event(1, 'job.queued'), event(2, 'job.started')];
    await boot();
    await vi.waitFor(() => expect(document.querySelectorAll('[data-slot="job-timeline"] [data-event-seq]').length).toBe(2));
    expect([...document.querySelectorAll<HTMLElement>('[data-slot="job-timeline"] [data-event-seq]')].map((e) => e.dataset.eventSeq)).toEqual(['2', '1']);
    const before = bomReads;
    events = [...events, event(3, 'question.asked')];
    await act(async () => { FakeEventSource.last!.send(event(3, 'question.asked')); });
    await vi.waitFor(() => expect(bomReads).toBeGreaterThan(before));
    await vi.waitFor(() => expect(document.querySelectorAll('[data-slot="job-timeline"] [data-event-seq]').length).toBe(3));
  });
});
