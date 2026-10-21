// @vitest-environment happy-dom
// The Jobs view as a long page (issue #2353): a job row is one line, the list shows 30 to a page with Back and More, a
// filter starts again at the first page; the header, its filters and the stage counts stay in view; the mode and a tree
// folded are kept over a reload. The whole app over a fake daemon, its job graph made by the real jobGraph.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jobGraph } from '../../src/domain/job-graph.ts';
import type { Job, JobStatus } from '../../src/domain/types.ts';

const REPOS = ['acme/widgets', 'acme/site', 'other-org/tools'];
const STATUSES: JobStatus[] = ['queued', 'running', 'waiting_answer', 'finished', 'failed'];

const pointed = (n: number, status: JobStatus): Job => {
  const repo = REPOS[n % REPOS.length]!;
  return {
    id: `job-${n}`, spec: { executor: 'test', payload: {}, goal: `goal ${n}` }, priority: 50, status, approved: false,
    createdAt: '2026-10-01T00:00:00Z', updatedAt: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(), attempts: 1,
    source: { source: 'github', kind: 'issue', key: `https://github.com/${repo}/issues/${n}`, url: `https://github.com/${repo}/issues/${n}`, repo, number: n },
  } as Job;
};

let jobs: Job[] = [];

function fakeDaemon() {
  const of = (...s: JobStatus[]) => jobs.filter((j) => s.includes(j.status));
  const routes: Record<string, () => unknown> = {
    '/api/health': () => ({ ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 }),
    '/api/queue': () => ({ waiting: of('queued'), running: of('running'), operatorLed: [], parked: [], waitingAnswer: of('waiting_answer'), ended: of('finished', 'failed'), locked: [] }),
    '/api/machines': () => ({ machines: [] }), '/api/jobs/last-events': () => ({ events: [] }),
    '/api/jobs/graph': () => jobGraph({ jobs, questions: [], items: new Map() }),
    '/api/decisions': () => ({ decisions: [] }), '/api/events': () => ({ events: [] }),
    '/api/webhooks': () => ({ subscriptions: [] }), '/api/webhooks/deliveries': () => ({ deliveries: [] }),
    '/api/questions': () => ({ questions: [] }), '/api/sources': () => ({ sources: [] }), '/api/accounts': () => ({ accounts: [] }),
    '/api/usage': () => ({ readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }),
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string) => {
    const path = String(input).split('?')[0]!;
    if (path === '/ui/api/session') return json({ authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'viewer', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
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

/** `kept`: a reload, with what the browser kept; else a browser that kept nothing, in list mode (the default). */
async function boot(mode: 'list' | 'kept' = 'list') {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  act(() => root?.unmount());
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#jobs';
  if (mode !== 'kept') localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', fakeDaemon());
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(document.querySelector('[data-slot="jobs-mode-list"]')).not.toBeNull());
  if (mode === 'list') await vi.waitFor(() => expect(cards().length).toBe(Math.min(jobs.length, 30)));
}

async function click(el: HTMLElement | SVGElement) {
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

const cards = () => [...document.querySelectorAll<HTMLElement>('[data-slot="job-row"]')];

async function choose(name: string, value: string) {
  const select = document.querySelector<HTMLSelectElement>(`[data-slot="${name}"]`)!;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('the Jobs view as a long page (issue #2353)', () => {
  it('shows one line per job, 30 to a page, with Back and More', async () => {
    jobs = Array.from({ length: 200 }, (_, n) => pointed(n, STATUSES[n % STATUSES.length]!));
    await boot();
    expect(document.querySelector('[data-slot="jobs-list"] [data-slot="job-card"]')).toBeNull();
    expect(cards().every((r) => r.tagName === 'TR' && r.querySelectorAll('div').length === 0)).toBe(true);
    const range = () => document.querySelector('[data-slot="pager-range"]')?.textContent;
    expect(range()).toBe('1–30 of 200');
    const first = cards().map((r) => r.dataset.jobId);
    await click(document.querySelector<HTMLElement>('[data-slot="pager-more"]')!);
    expect(range()).toBe('31–60 of 200');
    expect(cards()).toHaveLength(30);
    expect(cards().some((r) => first.includes(r.dataset.jobId))).toBe(false);
    // A filter starts again at its first page.
    await choose('jobs-filter-repo', 'acme/widgets');
    expect(range()).toBe('1–30 of 67');
    await click(document.querySelector<HTMLElement>('[data-slot="pager-back"]')!);
    expect(range()).toBe('1–30 of 67');
  });

  it('no pager when every job fits one page', async () => {
    jobs = Array.from({ length: 30 }, (_, n) => pointed(n, 'queued'));
    await boot();
    expect(document.querySelector('[data-slot="pager"]')).toBeNull();
  });

  it('keeps the header, its filters and the stage counts in view', async () => {
    jobs = [pointed(1, 'queued')];
    await boot();
    const header = document.querySelector<HTMLElement>('[data-slot="panel-header"][data-sticky]')!;
    expect(header.className).toContain('sticky');
    expect(header.querySelector('[data-slot="jobs-filter-stage"]')).not.toBeNull();
    expect(header.querySelector('[data-slot="jobs-stage-counts"]')).not.toBeNull();
  });

  it('keeps the mode and a folded tree over a reload', async () => {
    jobs = [pointed(1, 'queued'), pointed(2, 'finished')];
    await boot();
    expect(document.querySelector('[data-slot="jobs-mode-list"]')?.getAttribute('aria-pressed')).toBe('true');
    await boot('kept');
    await vi.waitFor(() => expect(cards()).toHaveLength(2));
    expect(document.querySelector('[data-slot="jobs-mode-list"]')?.getAttribute('aria-pressed')).toBe('true');
    await click(document.querySelector<HTMLElement>('[data-slot="jobs-mode-graph"]')!);
    const tree = () => document.querySelector<HTMLElement>('[data-slot="job-tree"]')!;
    await vi.waitFor(() => expect(tree()).not.toBeNull());
    const root = tree().dataset.root!;
    const wasOpen = tree().dataset.open !== undefined;
    await click(tree().querySelector('button')!);
    expect(tree().dataset.open !== undefined).toBe(!wasOpen);
    await boot('kept');
    await vi.waitFor(() => expect(document.querySelector(`[data-slot="job-tree"][data-root="${root}"]`)).not.toBeNull());
    expect(document.querySelector<HTMLElement>(`[data-slot="job-tree"][data-root="${root}"]`)!.dataset.open !== undefined).toBe(!wasOpen);
  });
});
