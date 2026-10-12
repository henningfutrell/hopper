// @vitest-environment happy-dom
// Issues #434, #900: the Jobs view, rendered inside the whole app against a fake of the daemon's HTTP surface, its job
// graph made by the real jobGraph. The graph mode: a section per job tree, a node per job, issue and pull request, what
// blocks the root marked, a node's details on select. The list mode: a row per job with its stage, issue
// (owner/repo#number), lane, task count, pull request and last event; a partly done job names the pull request it waits
// on. Counts per stage; filters by stage and by repository; a stage change arrives live, with no reload; 250 jobs render.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jobGraph, type JobGraphWait } from '../../src/domain/job-graph.ts';
import type { DomainEvent, Job, JobStatus } from '../../src/domain/types.ts';

const REPOS = ['acme/widgets', 'acme/site', 'other-org/tools'];
const STATUSES: JobStatus[] = ['queued', 'running', 'waiting_answer', 'finished', 'failed'];

const pointed = (n: number, status: JobStatus): Job => {
  const repo = REPOS[n % REPOS.length]!;
  return {
    id: `job-${n}`, spec: { executor: 'test', payload: {}, goal: `goal ${n}` }, priority: 50, status, approved: false,
    createdAt: '2026-10-01T00:00:00Z', updatedAt: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(), attempts: 1,
    ...(status === 'running' ? { laneId: `m1/lane-${n}` } : {}),
    source: { source: 'github', kind: 'issue', key: `https://github.com/${repo}/issues/${n}`, url: `https://github.com/${repo}/issues/${n}`, repo, number: n },
  } as Job;
};
const event = (seq: number, jobId: string, type: string): DomainEvent =>
  ({ seq, schemaVersion: 1, id: `e${seq}`, type, at: '2026-10-01T01:00:00Z', jobId, data: {} } as DomainEvent);

let jobs: Job[] = [];
let questions: JobGraphWait[] = [];

function fakeDaemon() {
  const queue = () => {
    const of = (...s: JobStatus[]) => jobs.filter((j) => s.includes(j.status));
    return { waiting: of('queued'), running: of('claimed', 'running'), operatorLed: [], parked: [], waitingAnswer: of('waiting_answer'), ended: of('finished', 'failed'), locked: [] };
  };
  const routes: Record<string, () => unknown> = {
    '/api/health': () => ({ ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 }),
    '/api/queue': queue,
    '/api/machines': () => ({ machines: [{ id: 'm1', label: 'box', maxLanes: 300, online: true, executors: ['test'], usage: [], lanes: [] }] }),
    '/api/jobs/last-events': () => ({ events: jobs.map((j, i) => event(i + 1, j.id, 'job.queued')) }),
    '/api/jobs/graph': () => jobGraph({ jobs, questions }),
    '/api/decisions': () => ({ decisions: [] }), '/api/events': () => ({ events: [] }),
    '/api/webhooks': () => ({ subscriptions: [] }), '/api/webhooks/deliveries': () => ({ deliveries: [] }),
    '/api/questions': () => ({ questions: [] }), '/api/sources': () => ({ sources: [] }),
    '/api/usage': () => ({ readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }), '/api/accounts': () => ({ accounts: [] }),
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

async function boot(mode: 'graph' | 'list' = 'list') {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#jobs';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', fakeDaemon());
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(document.querySelector('[data-slot="jobs-mode-list"]')).not.toBeNull());
  if (mode === 'list') {
    await click(document.querySelector<HTMLElement>('[data-slot="jobs-mode-list"]')!);
    await vi.waitFor(() => expect(cards().length).toBe(jobs.length));
  }
}

async function click(el: HTMLElement | SVGElement) {
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

const cards = () => [...document.querySelectorAll<HTMLElement>('[data-slot="job-card"]')];
const card = (id: string) => document.querySelector<HTMLElement>(`[data-slot="job-card"][data-job-id="${id}"]`)!;
const slot = (el: HTMLElement, name: string) => el.querySelector<HTMLElement>(`[data-slot="${name}"]`)?.textContent ?? '';

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
  questions = [];
  vi.unstubAllGlobals();
});

describe('the Jobs view (issue #434)', () => {
  it('has a nav entry', async () => {
    jobs = [pointed(1, 'queued')];
    await boot();
    expect(document.querySelector('nav a[href="#jobs"]')?.textContent).toContain('Jobs');
  });

  it('shows a row per job with its stage, issue, lane, task count and last event', async () => {
    jobs = [{ ...pointed(1, 'running'), tasks: { done: 2, total: 5 } }, pointed(2, 'queued')];
    await boot();
    const running = card('job-1');
    expect(running.dataset.stage).toBe('running');
    expect(slot(running, 'card-tasks')).toBe('2/5');
    expect(slot(running, 'card-issue')).toBe('acme/site#1');
    expect(running.querySelector<HTMLAnchorElement>('[data-slot="card-issue"] a')?.href).toBe('https://github.com/acme/site/issues/1');
    expect(slot(running, 'card-lane')).toBe('box (m1) · lane-1');
    await vi.waitFor(() => expect(slot(running, 'card-last-event')).toContain('job.queued'));
    expect(slot(card('job-2'), 'card-lane')).toBe('no lane');
    expect(running.querySelector<HTMLAnchorElement>('a[href="#job/job-1"]')).not.toBeNull();
  });

  it('a partly done job names the pull request it waits on and what runs after the merge', async () => {
    const pr = 'https://github.com/acme/site/pull/70';
    jobs = [{ ...pointed(1, 'finished'), partlyDone: pr, sourceState: { source: { pullRequest: pr, follow: 'open', seen: { draft: false, conflicting: false, checks: 'passing' } } } }];
    await boot();
    expect(card('job-1').dataset.stage).toBe('partly_done');
    expect(slot(card('job-1'), 'card-partly-done')).toBe('waits on the merge of PR #70; then the next part of acme/site#1 runs');
    expect(slot(card('job-1'), 'card-pr')).toContain('checks passing');
  });

  it('counts the jobs per stage, and filters by stage and by repository, and says how many show', async () => {
    jobs = Array.from({ length: 30 }, (_, n) => pointed(n, STATUSES[n % STATUSES.length]!));
    await boot();
    const count = (stage: string) => document.querySelector<HTMLElement>(`[data-slot="jobs-stage-count"][data-stage="${stage}"]`)!;
    expect(count('running').textContent).toContain('6');
    expect(count('waiting').textContent).toContain('6');
    await click(count('failed'));
    expect(cards().every((c) => c.dataset.stage === 'failed')).toBe(true);
    await click(count('failed'));
    await choose('jobs-filter-stage', 'running');
    expect(cards().every((c) => c.dataset.stage === 'running')).toBe(true);
    expect(cards()).toHaveLength(6);
    await choose('jobs-filter-repo', 'acme/widgets');
    expect(cards().map((c) => c.dataset.jobId)).toEqual(['job-21', 'job-6']);
    expect(document.querySelector('[data-slot="jobs-count"]')?.textContent).toContain('2 of 30');
    await choose('jobs-filter-stage', '');
    expect(cards().every((c) => slot(c, 'card-issue').startsWith('acme/widgets#'))).toBe(true);
    expect(cards()).toHaveLength(10);
  });

  it('a stage change reaches its row live, with no reload', async () => {
    jobs = Array.from({ length: 250 }, (_, n) => pointed(n, STATUSES[n % STATUSES.length]!));
    await boot();
    expect(card('job-0').dataset.stage).toBe('queued');
    jobs = jobs.map((j) => (j.id === 'job-0' ? { ...j, status: 'running', laneId: 'm1/lane-0' } : j));
    await act(async () => { FakeEventSource.last!.send(event(1000, 'job-0', 'job.started')); });
    await vi.waitFor(() => expect(card('job-0').dataset.stage).toBe('running'));
    expect(slot(card('job-0'), 'card-last-event')).toContain('job.started');
    expect(slot(card('job-0'), 'card-lane')).toBe('box (m1) · lane-0');
    expect(cards()).toHaveLength(250);
  });

  it('opens in the graph mode: a tree per root, its nodes, what blocks the root, and a node\'s details on select', async () => {
    const pr = 'https://github.com/acme/site/pull/70';
    const part = { ...pointed(1, 'finished'), partlyDone: pr, sourceState: { source: { pullRequest: pr, follow: 'open' } } } as Job;
    const next = { ...pointed(1, 'running'), id: 'job-next', rerunOf: part.id, tasks: { done: 1, total: 3 }, createdAt: '2026-10-02T00:00:00Z' } as Job;
    jobs = [part, next, pointed(2, 'finished')];
    await boot('graph');
    await vi.waitFor(() => expect(document.querySelectorAll('[data-slot="job-tree"]')).toHaveLength(2));
    const tree = document.querySelector<HTMLElement>('[data-slot="job-tree"][data-root="issue:acme/site#1"]')!;
    expect(tree.dataset.open).toBe('');
    const node = (id: string) => tree.querySelector<SVGElement>(`[data-slot="graph-node"][data-node-id="${id}"]`)!;
    expect(node('job:job-1').dataset.stage).toBe('partly_done');
    expect(node(`pr:${pr}`).dataset.kind).toBe('pull_request');
    expect(node('job:job-next').textContent).toContain('1/3');
    expect(node('job:job-next').dataset.blocking).toBe('');
    const kinds = [...tree.querySelectorAll<SVGElement>('[data-slot="graph-edge"]')].map((e) => e.dataset.kind).sort();
    expect(kinds).toEqual(['next_part', 'waits_on_merge', 'works', 'works']);
    expect(slot(tree, 'job-tree-blocking')).toBe('3 blocking');
    // Nothing blocks the other tree's root: it starts folded.
    expect(document.querySelector<HTMLElement>('[data-slot="job-tree"][data-root="issue:other-org/tools#2"]')!.dataset.open).toBeUndefined();
    await click(node('job:job-1'));
    const details = document.querySelector<HTMLElement>('[data-slot="graph-node-details"]')!;
    expect(details.dataset.nodeId).toBe('job:job-1');
    expect(details.textContent).toContain('the next part of acme/site#1 runs');
    expect(details.textContent).toContain('next part');
  });

  it('shows an open question as a node of its job that blocks the root, and links its details to the job', async () => {
    jobs = [pointed(1, 'waiting_answer')];
    questions = [{ id: 'q1', jobId: 'job-1', text: 'Which store should the cache use?', since: '2026-10-01T02:00:00Z' }];
    await boot('graph');
    const tree = await vi.waitFor(() => document.querySelector<HTMLElement>('[data-slot="job-tree"][data-root="issue:acme/site#1"]')!);
    const node = tree.querySelector<SVGElement>('[data-slot="graph-node"][data-node-id="question:q1"]')!;
    expect(node.dataset.kind).toBe('question');
    expect(node.dataset.blocking).toBe('');
    expect(node.textContent).toContain('question · waiting');
    expect([...tree.querySelectorAll<SVGElement>('[data-slot="graph-edge"]')].map((e) => e.dataset.kind).sort()).toEqual(['asks', 'works']);
    await click(node);
    const details = document.querySelector<HTMLElement>('[data-slot="graph-node-details"]')!;
    expect(details.querySelector<HTMLAnchorElement>('a[href="#job/job-1"]')?.textContent).toBe('Which store should the cache use?');
    expect(details.textContent).toContain('asks this');
  });

  it('says so when there is no job, in both modes', async () => {
    jobs = [];
    await boot('graph');
    await vi.waitFor(() => expect(document.querySelector('[data-slot="jobs-graph"]')?.textContent).toContain('No jobs yet'));
    await click(document.querySelector<HTMLElement>('[data-slot="jobs-mode-list"]')!);
    expect(document.querySelector('[data-slot="jobs-list"]')?.textContent).toContain('No jobs yet');
  });
});
