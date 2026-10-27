// @vitest-environment happy-dom
// Issues #2840, #2861: the Planned work tab of Jobs, rendered in happy-dom inside the whole app against a fake of the
// daemon. With no plan named it lists the kept work plans; it opens the work plan the hash names from the plan store,
// draws its plan pieces, plan tasks and jobs coloured by plan status, shows how many plan tasks are in each status, opens a
// node's artifact link, issue or job on a click, saves the CSV and JSON exports, imports a plan the store does not keep,
// turns its sync off, and adds and removes plan artifacts.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const issue = (n: number) => ({ id: `acme/app#${n}`, repo: 'acme/app', number: n, title: `title ${n}`, url: `https://github.com/acme/app/issues/${n}` });
const at = '2026-10-03T00:00:00Z';
const SHOT = { id: 'art-1', type: 'screenshot', ref: 'https://example.com/shot.png', source: 'person', by: 'someone', createdAt: at, updatedAt: at };
const PLAN = {
  ...issue(1), status: 'blocked', sync: 'github', syncedAt: at, counts: { planned: 1, running: 1, done: 1, blocked: 1 }, jobs: [],
  pieces: [
    { ...issue(2), status: 'running', artifacts: [SHOT], jobs: [], tasks: [
      { ...issue(4), status: 'done', dependsOn: [], artifacts: [], jobs: [{ id: 'job-done-1', status: 'finished', stage: 'done', stageText: 'Done', planStatus: 'done' }] },
      { ...issue(5), status: 'running', dependsOn: ['acme/app#4'], artifacts: [], jobs: [{ id: 'job-run-2', status: 'running', stage: 'running', stageText: 'Building it', planStatus: 'running' }] },
    ] },
    { ...issue(3), status: 'blocked', artifacts: [], jobs: [], tasks: [
      { ...issue(6), status: 'blocked', dependsOn: [], artifacts: [], jobs: [{ id: 'job-fail-3', status: 'failed', stage: 'failed', stageText: 'Failed', planStatus: 'blocked' }] },
      { ...issue(7), status: 'planned', dependsOn: [], artifacts: [], jobs: [] },
    ] },
  ],
};

const asked: string[] = [];
const posted: [string, unknown][] = [];
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
  return vi.fn(async (input: string, init?: RequestInit) => {
    const [path = '', query = ''] = String(input).split('?');
    asked.push(String(input));
    if (init?.method === 'POST' && path.startsWith('/ui/api/planned-work/')) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posted.push([path, body]);
      if (path === '/ui/api/planned-work/sync') return json(200, { ...PLAN, sync: body.sync ?? PLAN.sync });
      if (path === '/ui/api/planned-work/import') return json(200, PLAN);
      return json(200, path.endsWith('/remove') ? { removed: true } : { ...SHOT, id: 'art-2' });
    }
    if (path === '/api/planned-work/plans') return json(200, { plans: [{ ...PLAN, pieces: 2, tasks: 4, jobs: undefined }] });
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'admin', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (path === '/api/planned-work') return new URLSearchParams(query).get('plan') === 'acme/app#1' ? json(200, PLAN) : json(404, { error: 'no work plan acme/app#99 is kept: import it first (POST /ui/api/planned-work/import)' });
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
  posted.length = 0;
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

describe('the Planned work tab (issues #2840, #2861)', () => {
  it('is a tab of Jobs; with no plan named it lists the kept work plans, each a link to its graph', async () => {
    await boot('#jobs/planned-work');
    await vi.waitFor(() => expect(document.querySelector('[data-slot="planned-work-plan"][data-plan-id="acme/app#1"]')).not.toBeNull());
    expect(asked).toContain('/api/planned-work/plans');
    expect(document.querySelector('[data-slot="planned-work-plan"] a')?.getAttribute('href')).toBe('#jobs/planned-work/acme%2Fapp%231');
    expect(document.querySelector('[data-slot="planned-work-plan"]')?.textContent).toContain('2 pieces · 4 tasks · sync from GitHub');
    expect(document.querySelector('[data-slot="page-tabs"] a[href="#jobs/planned-work"]')?.getAttribute('aria-current')).toBe('page');
  });

  it('draws the plan the hash names, coloured by plan status, with the counts of plan tasks', async () => {
    await boot('#jobs/planned-work/acme%2Fapp%231');
    await vi.waitFor(() => expect(node('plan:acme/app#1')).not.toBeNull());
    expect(asked).toContain('/api/planned-work?plan=acme%2Fapp%231');
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

  it('CSV and JSON save the export, with the session header', async () => {
    await boot('#jobs/planned-work/acme%2Fapp%231');
    const made: string[] = [];
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { made.push(this.download); });
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-slot="planned-work-export-csv"]')?.disabled).toBe(false));
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-slot="planned-work-export-csv"]')!.click(); });
    await vi.waitFor(() => expect(made).toEqual(['planned-work-acme-app-1.csv']));
    expect(asked).toContain('/api/planned-work/export?plan=acme%2Fapp%231&format=csv');
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-slot="planned-work-export-json"]')!.click(); });
    await vi.waitFor(() => expect(asked).toContain('/api/planned-work/export?plan=acme%2Fapp%231&format=json'));
    click.mockRestore();
  });

  it('a plan the store does not keep says so, and Import keeps it from its issue and opens it', async () => {
    await boot('#jobs/planned-work/acme%2Fapp%2399');
    await vi.waitFor(() => expect(document.querySelector('[data-slot="planned-work-error"]')?.textContent).toContain('no work plan acme/app#99 is kept'));
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-slot="planned-work-import"]')!.click(); });
    await vi.waitFor(() => expect(window.location.hash).toBe('#jobs/planned-work/acme%2Fapp%231'));
    expect(posted).toEqual([['/ui/api/planned-work/import', { issue: 'acme/app#99' }]]);
  });

  it('shows the sync and turns it off; adds a plan artifact to a task, and removes one', async () => {
    await boot('#jobs/planned-work/acme%2Fapp%231');
    await vi.waitFor(() => expect(document.querySelector('[data-slot="planned-work-sync"]')?.getAttribute('data-sync')).toBe('github'));
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-slot="planned-work-sync-off"]')!.click(); });
    await vi.waitFor(() => expect(document.querySelector('[data-slot="planned-work-sync"]')?.getAttribute('data-sync')).toBe('off'));
    expect(document.querySelector('[data-slot="planned-work-artifact"][data-artifact-id="art-1"]')?.textContent).toContain('https://example.com/shot.png');
    const form = document.querySelector<HTMLFormElement>('[data-slot="planned-work-artifact-add"]')!;
    const set = (el: HTMLInputElement | HTMLSelectElement, v: string) => {
      const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v);
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    };
    await act(async () => { set(form.querySelector('select[name="task"]')!, 'acme/app#5'); });
    await act(async () => { set(form.querySelector('select[name="type"]')!, 'report'); });
    await act(async () => { set(form.querySelector('input[name="ref"]')!, 'https://example.com/report'); });
    await act(async () => { form.requestSubmit(); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="Remove artifact https://example.com/shot.png"]')!.click(); });
    await vi.waitFor(() => expect(posted.map(([p]) => p)).toEqual(['/ui/api/planned-work/sync', '/ui/api/planned-work/artifacts', '/ui/api/planned-work/artifacts/remove']));
    expect(posted[0]![1]).toEqual({ plan: 'acme/app#1', sync: 'off' });
    expect(posted[1]![1]).toEqual({ plan: 'acme/app#1', piece: 'acme/app#2', task: 'acme/app#5', type: 'report', ref: 'https://example.com/report' });
    expect(posted[2]![1]).toEqual({ plan: 'acme/app#1', id: 'art-1' });
  });
});
