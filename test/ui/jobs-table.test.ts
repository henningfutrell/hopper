// @vitest-environment happy-dom
// Issue #2372: the Jobs view opens as a compact table, one row per job, its run graph on expand. The whole app over a fake
// daemon, its job graph made by the real jobGraph.
//
// Feature: the Jobs table
//   Scenario: a browser that kept nothing opens Jobs in List, a table with the stage, issue, title, lane, time in stage and pull request
//   Scenario: Graph or List is the same toggle as before, kept over a reload
//   Scenario: a click on a row opens its run graph under it, and a second click folds it
//   Scenario: a job whose kept delivery track is open shows its delivery step, since when and what it waits on (issue #2775)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jobGraph } from '../../src/domain/job-graph.ts';
import type { KeptTrack } from '../../src/domain/kept-tracks.ts';
import type { Job, JobStatus } from '../../src/domain/types.ts';

const pointed = (n: number, status: JobStatus, repo = 'acme/site'): Job => ({
  id: `job-${n}`, spec: { executor: 'test', payload: {}, goal: `goal ${n}` }, priority: 50, status, approved: false,
  createdAt: '2026-10-01T00:00:00Z', updatedAt: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(), attempts: 1,
  ...(status === 'running' ? { laneId: `m1/lane-${n}` } : {}),
  source: { source: 'github', kind: 'issue', key: `https://github.com/${repo}/issues/${n}`, url: `https://github.com/${repo}/issues/${n}`, repo, number: n },
} as Job);

let jobs: Job[] = [];
let tracks: KeptTrack[] = [];
const asked: string[] = [];

function fakeDaemon() {
  const of = (...s: JobStatus[]) => jobs.filter((j) => s.includes(j.status));
  const routes: Record<string, () => unknown> = {
    '/api/health': () => ({ ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 }),
    '/api/queue': () => ({ waiting: of('queued'), running: of('running'), operatorLed: [], parked: [], waitingAnswer: of('waiting_answer'), ended: of('finished', 'failed'), locked: [] }),
    '/api/machines': () => ({ machines: [{ id: 'm1', label: 'box', maxLanes: 30, online: true, executors: ['test'], usage: [], lanes: [] }] }),
    '/api/jobs/last-events': () => ({ events: [] }),
    '/api/jobs/graph': () => jobGraph({ jobs, questions: [], items: new Map() }),
    '/api/delivery-tracks': () => ({ tracks }),
    '/api/decisions': () => ({ decisions: [] }), '/api/events': () => ({ events: [] }),
    '/api/webhooks': () => ({ subscriptions: [] }), '/api/webhooks/deliveries': () => ({ deliveries: [] }),
    '/api/questions': () => ({ questions: [] }), '/api/sources': () => ({ sources: [] }), '/api/accounts': () => ({ accounts: [] }),
    '/api/usage': () => ({ readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }),
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string) => {
    asked.push(String(input));
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

/** `kept`: a reload, with what the browser kept; else a browser that kept nothing. Clicks no mode. */
async function boot(kept = false) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  act(() => root?.unmount());
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#jobs';
  if (!kept) localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', fakeDaemon());
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(document.querySelector('[data-slot="jobs-mode-list"]')).not.toBeNull());
}

async function click(el: Element) {
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

const rows = () => [...document.querySelectorAll<HTMLElement>('[data-slot="job-row"]')];
const row = (id: string) => document.querySelector<HTMLElement>(`[data-slot="job-row"][data-job-id="${id}"]`)!;
const pressed = (mode: string) => document.querySelector(`[data-slot="jobs-mode-${mode}"]`)?.getAttribute('aria-pressed');

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  tracks = [];
  asked.length = 0;
  vi.unstubAllGlobals();
});

describe('the Jobs table (issue #2372)', () => {
  it('opens in List, a table with a row per job: stage, issue, title, lane, time in stage and pull request', async () => {
    const pr = 'https://github.com/acme/site/pull/70';
    jobs = [{ ...pointed(1, 'finished'), sourceState: { source: { pullRequest: pr, follow: 'open', seen: { draft: false, conflicting: false, checks: 'passing' } } } } as Job, pointed(2, 'running')];
    await boot();
    expect(pressed('list')).toBe('true');
    expect(pressed('graph')).toBe('false');
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    const table = document.querySelector<HTMLTableElement>('[data-slot="jobs-list"] table')!;
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(['', 'Stage', 'Issue', 'Title', 'Lane', 'In stage', 'Pull request', 'Delivery', 'Last event']);
    expect(rows().every((r) => r.tagName === 'TR')).toBe(true);
    expect(document.querySelector('[data-slot="jobs-graph"]')).toBeNull();
    const cells = [...row('job-1').children].map((c) => (c as HTMLElement).dataset.slot);
    expect(cells).toEqual(['row-expand', 'row-stage', 'row-issue', 'row-title', 'row-lane', 'row-since', 'row-pull-request', 'row-delivery', 'row-last-event']);
    expect(row('job-1').querySelector<HTMLAnchorElement>('[data-slot="row-pr"] a')?.href).toBe(pr);
    expect(row('job-2').querySelector('[data-slot="row-lane"]')?.textContent).toBe('box (m1) · lane-2');
    // The filters and the stage counts stay above the table.
    const header = document.querySelector<HTMLElement>('[data-slot="panel-header"]')!;
    expect(header.querySelector('[data-slot="jobs-filter-stage"]')).not.toBeNull();
    expect(header.querySelector('[data-slot="jobs-filter-repo"]')).not.toBeNull();
    expect(header.querySelector('[data-slot="jobs-stage-counts"]')).not.toBeNull();
  });

  it('keeps Graph or List over a reload', async () => {
    jobs = [pointed(1, 'queued')];
    await boot();
    await click(document.querySelector('[data-slot="jobs-mode-graph"]')!);
    await vi.waitFor(() => expect(document.querySelector('[data-slot="job-tree"]')).not.toBeNull());
    await boot(true);
    expect(pressed('graph')).toBe('true');
    await vi.waitFor(() => expect(document.querySelector('[data-slot="job-tree"]')).not.toBeNull());
    await click(document.querySelector('[data-slot="jobs-mode-list"]')!);
    await boot(true);
    expect(pressed('list')).toBe('true');
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
  });

  it('a click on a row opens its run graph under it; a second click folds it', async () => {
    const first = { ...pointed(1, 'failed'), createdAt: '2026-10-01T00:00:00Z' } as Job;
    const again = { ...pointed(1, 'running'), id: 'job-again', rerunOf: first.id, createdAt: '2026-10-02T00:00:00Z' } as Job;
    jobs = [first, again, pointed(2, 'queued', 'acme/widgets')];
    await boot();
    await vi.waitFor(() => expect(rows()).toHaveLength(3));
    const graph = () => document.querySelector<HTMLElement>('[data-slot="job-row-graph"]');
    expect(graph()).toBeNull();
    await click(row('job-again').querySelector('[data-slot="row-stage"]')!);
    expect(row('job-again').getAttribute('aria-expanded')).toBe('true');
    expect(graph()?.dataset.jobId).toBe('job-again');
    expect(row('job-again').nextElementSibling).toBe(graph());
    // Its tree: both runs of the issue, and the issue itself; not the other repository's job.
    const nodes = [...graph()!.querySelectorAll<SVGElement>('[data-slot="graph-node"]')].map((n) => n.dataset.nodeId).sort();
    expect(nodes).toEqual(['issue:acme/site#1', 'job:job-1', 'job:job-again']);
    // A node opens its details, as in Graph.
    await click(graph()!.querySelector('[data-slot="graph-node"][data-node-id="job:job-1"]')!);
    expect(graph()!.querySelector<HTMLElement>('[data-slot="graph-node-details"]')?.dataset.nodeId).toBe('job:job-1');
    // The expand button folds it; the title stays a link to the job page.
    await click(row('job-again').querySelector('[data-slot="row-expand"] button')!);
    expect(graph()).toBeNull();
    expect(row('job-again').getAttribute('aria-expanded')).toBe('false');
    expect(row('job-again').querySelector<HTMLAnchorElement>('[data-slot="row-title"] a')?.getAttribute('href')).toBe('#job/job-again');
  });

  it('shows the delivery step of a job whose kept delivery track is open, since when and what it waits on (issue #2775)', async () => {
    // job-1 finished: its fix merged on the landing branch, not promoted. job-2 runs: its track is in coding. job-3 has no open track.
    jobs = [pointed(1, 'finished'), pointed(2, 'running'), pointed(3, 'finished')];
    const waits = 'a green run of the checks on the landing branch that carries it (a batch run for the hopper)';
    tracks = [
      { jobId: 'job-1', marks: {}, steps: [], state: 'open', current: { step: 'landing_checks', since: '2026-10-01T02:00:00.000Z', blocker: 'ci_red', waitingOn: waits } },
      { jobId: 'job-2', marks: {}, steps: [], state: 'open', current: { step: 'coding', since: '2026-10-01T00:02:00.000Z', blocker: 'queue', waitingOn: 'the job to open its pull request' } },
    ] as unknown as KeptTrack[];
    await boot();
    await vi.waitFor(() => expect(row('job-1')?.querySelector('[data-slot="row-delivery"]')?.textContent).toBe('Landing checks'));
    expect(asked).toContain('/api/delivery-tracks?state=open');
    const cell = row('job-1').querySelector<HTMLElement>('[data-slot="row-delivery"]')!;
    expect(cell.title).toBe(`in Landing checks since 2026-10-01T02:00:00.000Z; waits on ${waits}`);
    expect(row('job-2').querySelector('[data-slot="row-delivery"]')?.textContent).toBe('Coding');
    expect(row('job-3').querySelector('[data-slot="row-delivery"]')?.textContent).toBe('');
  });

  it('marks a job whose change a delivery hold holds (issue #2775 part 8)', async () => {
    jobs = [pointed(1, 'finished')];
    tracks = [{
      jobId: 'job-1', marks: {}, steps: [], state: 'open', current: { step: 'landing_checks', since: '2026-10-01T02:00:00.000Z', blocker: 'ci_red', waitingOn: 'a green run' },
      hold: { by: 'release-owner', at: '2026-10-01T03:00:00.000Z', step: 'landing_checks', owner: 'person' },
    }] as unknown as KeptTrack[];
    await boot();
    await vi.waitFor(() => expect(row('job-1')?.querySelector('[data-slot="row-delivery"]')?.textContent).toBe('Landing checks, held'));
    expect(row('job-1').querySelector<HTMLElement>('[data-slot="row-delivery"]')!.title).toContain('held: a person took ownership of it');
  });
});
