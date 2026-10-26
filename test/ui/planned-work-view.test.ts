// @vitest-environment happy-dom
// Issue #2840: the Planned work tab of Jobs, rendered in happy-dom inside the whole app against a fake of the daemon. It
// opens the work plan the hash names, draws its plan pieces, plan tasks and jobs coloured by plan status, shows how many
// plan tasks are in each status, opens a node's artifact, issue or job on a click, and saves the CSV export.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const issue = (n: number) => ({ id: `acme/app#${n}`, repo: 'acme/app', number: n, title: `title ${n}`, url: `https://github.com/acme/app/issues/${n}` });
const PLAN = {
  ...issue(1), status: 'blocked', counts: { planned: 1, running: 1, done: 1, blocked: 1 }, jobs: [],
  pieces: [
    { ...issue(2), status: 'running', artifact: 'https://example.com/shot.png', jobs: [], tasks: [
      { ...issue(4), status: 'done', dependsOn: [], jobs: [{ id: 'job-done-1', status: 'finished', stage: 'done', stageText: 'Done', planStatus: 'done' }] },
      { ...issue(5), status: 'running', dependsOn: ['acme/app#4'], jobs: [{ id: 'job-run-2', status: 'running', stage: 'running', stageText: 'Building it', planStatus: 'running' }] },
    ] },
    { ...issue(3), status: 'blocked', jobs: [], tasks: [
      { ...issue(6), status: 'blocked', dependsOn: [], jobs: [{ id: 'job-fail-3', status: 'failed', stage: 'failed', stageText: 'Failed', planStatus: 'blocked' }] },
      { ...issue(7), status: 'planned', dependsOn: [], jobs: [] },
    ] },
  ],
};

const asked: string[] = [];
function fakeDaemon() {
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [], locked: [], gate: { mode: 'review', autoAcceptPerHour: null }, presort: { sorter: 'oldest-first', jobIds: [], reject: [] } },
    '/api/machines': { machines: [] }, '/api/events': { events: [] }, '/api/questions': { questions: [] }, '/api/sources': { sources: [] },
    // The job view a job node opens.
    '/api/connected-accounts': { accounts: [] },
    '/api/jobs/job-run-2': { id: 'job-run-2', spec: { executor: 'test', payload: {}, goal: 'goal' }, priority: 50, status: 'running', approved: true, attempts: 1, createdAt: '2026-10-03T10:00:00Z', updatedAt: '2026-10-03T10:00:00Z' },
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string) => {
    const [path = '', query = ''] = String(input).split('?');
    asked.push(String(input));
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'admin', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (path === '/api/planned-work') return new URLSearchParams(query).get('issue') === 'acme/app#1' ? json(200, PLAN) : json(404, { error: 'no issue acme/app#99 is known' });
    if (path === '/api/planned-work/export') return new Response('plan_id\n', { status: 200, headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="planned-work-acme-app-1.csv"' } });
    return json(200, routes[path] ?? {});
  });
}

class FakeEventSource { onopen: (() => void) | null = null; onerror: (() => void) | null = null; addEventListener(): void {} close(): void {} }

let root: Root | undefined;
async function boot(hash: string) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = hash;
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  asked.length = 0;
  vi.stubGlobal('fetch', fakeDaemon());
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx';
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

const node = (id: string) => document.querySelector<SVGGElement>(`[data-slot="plan-node"][data-node-id="${id}"]`);

describe('the Planned work tab (issue #2840)', () => {
  it('is a tab of Jobs; with no issue named it asks for one', async () => {
    await boot('#jobs/planned-work');
    await vi.waitFor(() => expect(document.querySelector('[data-slot="planned-work"]')?.textContent).toContain('Name an issue'));
    expect(document.querySelector('[data-slot="page-tabs"] a[href="#jobs/planned-work"]')?.getAttribute('aria-current')).toBe('page');
  });

  it('draws the plan the hash names, coloured by plan status, with the counts of plan tasks', async () => {
    await boot('#jobs/planned-work/acme%2Fapp%231');
    await vi.waitFor(() => expect(node('plan:acme/app#1')).not.toBeNull());
    expect(asked).toContain('/api/planned-work?issue=acme%2Fapp%231');
    const status = (id: string) => node(id)?.dataset.status;
    expect([status('piece:acme/app#2'), status('task:acme/app#4'), status('task:acme/app#5'), status('task:acme/app#6'), status('task:acme/app#7')])
      .toEqual(['running', 'done', 'running', 'blocked', 'planned']);
    expect(node('job:acme/app#6:job-fail-3')?.dataset.status).toBe('blocked');
    // Done is a solid fill; planned is dashed.
    expect(node('task:acme/app#4')?.querySelector('rect')?.getAttribute('fill')).toBe('var(--ok)');
    expect(node('task:acme/app#7')?.querySelector('rect')?.getAttribute('stroke-dasharray')).toBe('4 3');
    expect(document.querySelectorAll('[data-slot="plan-edge"][data-kind="depends_on"]')).toHaveLength(1);
    const counts = [...document.querySelectorAll<HTMLElement>('[data-slot="planned-work-count"]')].map((c) => [c.dataset.status, c.textContent]);
    expect(counts).toEqual([['planned', '1 planned'], ['running', '1 running'], ['done', '1 done'], ['blocked', '1 needs a person']]);
  });

  it('a click opens a piece\'s artifact link, a task\'s issue, or a job\'s view', async () => {
    const opened = vi.fn();
    await boot('#jobs/planned-work/acme%2Fapp%231');
    vi.stubGlobal('open', opened);
    await vi.waitFor(() => expect(node('piece:acme/app#2')).not.toBeNull());
    await act(async () => { node('piece:acme/app#2')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { node('task:acme/app#7')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(opened.mock.calls.map((c) => c[0])).toEqual(['https://example.com/shot.png', 'https://github.com/acme/app/issues/7']);
    await act(async () => { node('job:acme/app#5:job-run-2')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(window.location.hash).toBe('#job/job-run-2');
  });

  it('CSV saves the export, with the session header', async () => {
    await boot('#jobs/planned-work/acme%2Fapp%231');
    const made: string[] = [];
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { made.push(this.download); });
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-slot="planned-work-export-csv"]')?.disabled).toBe(false));
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-slot="planned-work-export-csv"]')!.click(); });
    await vi.waitFor(() => expect(made).toEqual(['planned-work-acme-app-1.csv']));
    expect(asked).toContain('/api/planned-work/export?issue=acme%2Fapp%231&format=csv');
    click.mockRestore();
  });

  it('an issue it does not know says so', async () => {
    await boot('#jobs/planned-work/acme%2Fapp%2399');
    await vi.waitFor(() => expect(document.querySelector('[data-slot="planned-work-error"]')?.textContent).toContain('no issue acme/app#99 is known'));
  });
});
