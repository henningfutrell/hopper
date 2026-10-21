// @vitest-environment happy-dom
// Issues #434, #900: the Jobs view, rendered inside the whole app against a fake of the daemon's HTTP surface, its job
// graph made by the real jobGraph. The graph mode: a section per job tree, a node per job, issue and pull request, what
// blocks the root marked, a node's details on select. The list mode: a row per job with its stage, issue
// (owner/repo#number), lane, task count, pull request and last event; a partly done job names the pull request it waits
// on. Counts per stage; filters by stage and by repository; a stage change arrives live, with no reload; 200 jobs render.
// Issue #2353 (jobs-long-page.test.ts): a row is one line, 30 to a page.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jobGraph, type JobGraphWait } from '../../src/domain/job-graph.ts';
import type { DomainEvent, Job, JobStatus } from '../../src/domain/types.ts';
import type { WorkItem } from '../../src/domain/work-items.ts';

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
let items = new Map<string, WorkItem>();
let inFlight: number | undefined;

function fakeDaemon() {
  const queue = () => {
    const of = (...s: JobStatus[]) => jobs.filter((j) => s.includes(j.status));
    return { waiting: of('queued'), running: of('claimed', 'running'), operatorLed: [], parked: [], waitingAnswer: of('waiting_answer'), ended: of('finished', 'failed'), locked: [], ...(inFlight !== undefined ? { inFlight: { total: inFlight, running: inFlight, ownCommand: 0, pullRequests: 0 } } : {}) };
  };
  const routes: Record<string, () => unknown> = {
    '/api/health': () => ({ ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 }),
    '/api/queue': queue,
    '/api/machines': () => ({ machines: [{ id: 'm1', label: 'box', maxLanes: 300, online: true, executors: ['test'], usage: [], lanes: [] }] }),
    '/api/jobs/last-events': () => ({ events: jobs.map((j, i) => event(i + 1, j.id, 'job.queued')) }),
    '/api/jobs/graph': () => jobGraph({ jobs, questions, items }),
    '/api/decisions': () => ({ decisions: [] }), '/api/events': () => ({ events: [] }),
    '/api/webhooks': () => ({ subscriptions: [] }), '/api/webhooks/deliveries': () => ({ deliveries: [] }),
    '/api/questions': () => ({ questions: [] }), '/api/sources': () => ({ sources: [] }),
    '/api/usage': () => ({ readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }), '/api/accounts': () => ({ accounts: [] }),
    // The in-flight badge is one the user chose (issue #1181): the default is the Lanes badge.
    '/api/header-badges': () => ({ badges: ['inFlight'] }),
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
    await vi.waitFor(() => expect(cards().length).toBe(Math.min(jobs.length, 30)));
  }
}

async function click(el: HTMLElement | SVGElement) {
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

const cards = () => [...document.querySelectorAll<HTMLElement>('[data-slot="job-row"]')];
const card = (id: string) => document.querySelector<HTMLElement>(`[data-slot="job-row"][data-job-id="${id}"]`)!;
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
  items = new Map();
  inFlight = undefined;
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
    expect(slot(running, 'row-tasks')).toBe('2/5');
    expect(slot(running, 'row-issue')).toBe('acme/site#1');
    expect(running.querySelector<HTMLAnchorElement>('[data-slot="row-issue"] a')?.href).toBe('https://github.com/acme/site/issues/1');
    expect(slot(running, 'row-lane')).toBe('box (m1) · lane-1');
    await vi.waitFor(() => expect(slot(running, 'row-last-event')).toContain('job.queued'));
    expect(slot(card('job-2'), 'row-lane')).toBe('no lane');
    expect(running.querySelector<HTMLAnchorElement>('a[href="#job/job-1"]')).not.toBeNull();
  });

  it('a partly done job names the pull request it waits on and what runs after the merge', async () => {
    const pr = 'https://github.com/acme/site/pull/70';
    jobs = [{ ...pointed(1, 'finished'), partlyDone: pr, sourceState: { source: { pullRequest: pr, follow: 'open', seen: { draft: false, conflicting: false, checks: 'passing' } } } }];
    await boot();
    expect(card('job-1').dataset.stage).toBe('partly_done');
    expect(slot(card('job-1'), 'row-partly-done')).toBe('waits on the merge of PR #70; then the next part of acme/site#1 runs');
    expect(slot(card('job-1'), 'row-pr')).toContain('checks passing');
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
    expect(cards().every((c) => slot(c, 'row-issue').startsWith('acme/widgets#'))).toBe(true);
    expect(cards()).toHaveLength(10);
  });

  it('a stage change reaches its row live, with no reload', async () => {
    // One page of jobs (30 to a page): the row stays in view whatever its new place.
    jobs = Array.from({ length: 30 }, (_, n) => pointed(n, STATUSES[n % STATUSES.length]!));
    await boot();
    const id = 'job-0';
    const n = 0;
    expect(card(id).dataset.stage).toBe('queued');
    jobs = jobs.map((j) => (j.id === id ? { ...j, status: 'running', laneId: `m1/lane-${n}` } : j));
    await act(async () => { FakeEventSource.last!.send(event(1000, id, 'job.started')); });
    await vi.waitFor(() => expect(card(id).dataset.stage).toBe('running'));
    expect(slot(card(id), 'row-last-event')).toContain('job.started');
    expect(slot(card(id), 'row-lane')).toBe(`box (m1) · lane-${n}`);
    expect(cards()).toHaveLength(30);
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
    expect(slot(tree, 'job-tree-summary')).toBe('0 of 1 piece shipped, 1 in progress, nothing waiting on you.');
    // Plain words (issue #935): the title leads, the repository and number in small type, the stage in human terms.
    expect(node('job:job-next').querySelector('[data-slot="graph-node-title"]')?.textContent).toBe('goal 1');
    expect(node('job:job-next').querySelector('[data-slot="graph-node-ref"]')?.textContent).toBe('acme/site#1');
    expect(node('job:job-next').querySelector('[data-slot="graph-node-stage"]')?.textContent).toBe('Building it');
    // Nothing blocks the other tree's root: it starts folded.
    expect(document.querySelector<HTMLElement>('[data-slot="job-tree"][data-root="issue:other-org/tools#2"]')!.dataset.open).toBeUndefined();
    await click(node('job:job-1'));
    const details = document.querySelector<HTMLElement>('[data-slot="graph-node-details"]')!;
    expect(details.dataset.nodeId).toBe('job:job-1');
    expect(details.textContent).toContain('the next part of acme/site#1 runs');
    expect(details.textContent).toContain('continues in');
  });

  it('shows an open question as a node of its job that blocks the root, and links its details to the job', async () => {
    jobs = [pointed(1, 'waiting_answer')];
    questions = [{ id: 'q1', jobId: 'job-1', text: 'Which store should the cache use?', since: '2026-10-01T02:00:00Z' }];
    await boot('graph');
    const at = '[data-slot="job-tree"][data-root="issue:acme/site#1"] [data-slot="graph-node"][data-node-id="question:q1"]';
    await vi.waitFor(() => expect(document.querySelector(at)).not.toBeNull());
    const tree = document.querySelector<HTMLElement>('[data-slot="job-tree"][data-root="issue:acme/site#1"]')!;
    const node = document.querySelector<SVGElement>(at)!;
    expect(node.dataset.kind).toBe('question');
    expect(node.dataset.blocking).toBe('');
    expect(node.textContent).toContain('Waiting on you: answer it');
    expect([...tree.querySelectorAll<SVGElement>('[data-slot="graph-edge"]')].map((e) => e.dataset.kind).sort()).toEqual(['asks', 'works']);
    await click(node);
    const details = document.querySelector<HTMLElement>('[data-slot="graph-node-details"]')!;
    expect(details.querySelector<HTMLAnchorElement>('a[href="#job/job-1"]')?.textContent).toBe('Which store should the cache use?');
    expect(details.textContent).toContain('is waiting on your answer to this');
  });

  it('a job on its own wait says what it waits on, and its details link it with how long it waited (issue #1245)', async () => {
    jobs = [{ ...pointed(1, 'waiting_on'), wait: { for: 'the base change', since: '2026-10-01T02:00:00Z', on: { kind: 'pull_request', number: 12, about: 'merge' } } } as Job];
    await boot('graph');
    const at = '[data-slot="graph-node"][data-node-id="job:job-1"]';
    await vi.waitFor(() => expect(document.querySelector(at)).not.toBeNull());
    const node = document.querySelector<SVGElement>(at)!;
    expect(node.querySelector('[data-slot="graph-node-stage"]')?.textContent).toBe('Waiting on PR #12 to merge');
    await click(node);
    const details = document.querySelector<HTMLElement>('[data-slot="graph-node-details"]')!;
    expect(details.querySelector<HTMLAnchorElement>('[data-slot="graph-node-waits-on"] a')?.href).toBe('https://github.com/acme/site/pull/12');
    expect(details.textContent).toContain('in stage');
  });

  it('a pull request\'s details list its tend attempts, each linked to its job (issue #927)', async () => {
    const pr = 'https://github.com/acme/site/pull/70';
    const first = { ...pointed(1, 'finished'), sourceState: { source: { pullRequest: pr, follow: 'tended', tended: { pullRequest: pr, step: 'rebase', nextJobId: 'job-tend' } } } } as Job;
    const tend = { ...pointed(1, 'failed'), id: 'job-tend', rerunOf: first.id, createdAt: '2026-10-02T00:00:00Z' } as Job;
    jobs = [first, tend];
    await boot('graph');
    const at = `[data-slot="graph-node"][data-node-id="pr:${pr}"]`;
    await vi.waitFor(() => expect(document.querySelector(at)).not.toBeNull());
    await click(document.querySelector<SVGElement>(at)!);
    const tends = document.querySelector<HTMLElement>('[data-slot="graph-node-tends"]')!;
    expect(tends.textContent).toContain('rebase by job job-tend: failed');
    expect(tends.querySelector('a[href="#job/job-tend"]')).not.toBeNull();
  });

  it('says so when there is no job, in both modes', async () => {
    jobs = [];
    await boot('graph');
    await vi.waitFor(() => expect(document.querySelector('[data-slot="jobs-graph"]')?.textContent).toContain('No jobs yet'));
    await click(document.querySelector<HTMLElement>('[data-slot="jobs-mode-list"]')!);
    expect(document.querySelector('[data-slot="jobs-list"]')?.textContent).toContain('No jobs yet');
  });
});

const itemOf = (j: Job, state: WorkItem['state'], pullRequestWait?: WorkItem['pullRequestWait']): WorkItem => ({
  key: j.source!.key, jobId: j.id, state, stateSince: '2026-10-01T00:00:00Z', eventState: state, eventAt: '2026-10-01T00:00:00Z', keptWork: [], version: 1,
  ...(pullRequestWait ? { pullRequestWait } : {}),
});

describe('the in-flight badge (issue #1113)', () => {
  it('shows the ledger\'s in-flight count in the header, live, and opens the Jobs view filtered to in flight', async () => {
    jobs = [pointed(1, 'running'), pointed(2, 'queued'), pointed(3, 'finished'), pointed(4, 'finished')];
    items = new Map([itemOf(jobs[0]!, 'working'), itemOf(jobs[1]!, 'queued'), itemOf(jobs[2]!, 'pr_open', 'checks_running'), itemOf(jobs[3]!, 'pr_open', 'draft')].map((i) => [i.key, i]));
    inFlight = 2;
    await boot();
    const badge = () => document.querySelector<HTMLAnchorElement>('header [data-slot="in-flight"]');
    await vi.waitFor(() => expect(badge()?.textContent).toContain('2'));
    expect(badge()!.getAttribute('href')).toBe('#jobs/in-flight');

    // Live: the store reads the queue again after an event, with no polling.
    inFlight = 1;
    await act(async () => { FakeEventSource.last!.send(event(1000, 'job-1', 'job.finished')); });
    await vi.waitFor(() => expect(badge()?.textContent).toContain('1'));
    inFlight = 2;
    await act(async () => { FakeEventSource.last!.send(event(1001, 'job-1', 'job.started')); });
    await vi.waitFor(() => expect(badge()?.textContent).toContain('2'));

    // Its link: the Jobs view, only the jobs in flight, the filter on.
    await act(async () => {
      window.location.hash = '#jobs/in-flight';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await vi.waitFor(() => expect(cards().map((c) => c.dataset.jobId).sort()).toEqual(['job-1', 'job-3']));
    const toggle = document.querySelector<HTMLElement>('[data-slot="jobs-filter-in-flight"]')!;
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[data-slot="jobs-count"]')?.textContent).toContain('2 of 4');

    // Off: every job again.
    await click(toggle);
    await vi.waitFor(() => expect(cards()).toHaveLength(4));
    expect(window.location.hash).toBe('#jobs');
  });

  it('shows the count even at zero, and nothing before the queue is read', async () => {
    jobs = [pointed(2, 'queued')];
    inFlight = 0;
    await boot();
    await vi.waitFor(() => expect(document.querySelector('header [data-slot="in-flight"]')?.textContent).toContain('0'));
  });
});
