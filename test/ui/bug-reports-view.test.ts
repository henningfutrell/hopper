// @vitest-environment happy-dom
// Your reports (issue #694), its own view (issue #897), rendered against a fake of the daemon's HTTP: each report with its state —
// waiting with why, open or closed with its link —, newest first; Refresh sends the kept ones and reads the states.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

type El = ReturnType<typeof createElement>;
let root: Root | undefined;
let calls: { method: string; path: string }[] = [];

const REPORTS = [
  { id: 'r2', createdAt: '2026-10-10T12:00:00.000Z', by: 'job j7', jobId: 'j7', fromJob: true, title: 'Queue stalls', state: 'waiting', kind: 'issue', problem: 'GitHub answered 403 to a new issue', removed: ['repository', 'commit id'], tries: 2 },
  { id: 'r1', createdAt: '2026-10-09T12:00:00.000Z', by: 'octocat', title: 'Board hangs', state: 'closed', kind: 'issue', number: 12, url: 'https://github.com/henningfutrell/hopper/issues/12', tries: 1 },
];

async function render(after: unknown[], list: unknown[] = REPORTS) {
  calls = [];
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit = {}) => {
    calls.push({ method: init.method ?? 'GET', path: String(path) });
    return json({ reports: path === '/ui/api/bug-reports/refresh' ? after : list });
  }));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  const view = '../../ui/src/views/bug-reports.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const store = '../../ui/src/store/index.ts';
  const { useHopper } = (await import(store)) as { useHopper: { setState(s: Record<string, unknown>): void } };
  useHopper.setState({ authed: true, user: { id: 'u1', name: 'ada', role: 'operator', realm: 'local', identity: 'ada' } });
  const { BugReports } = (await import(view)) as { BugReports: () => El };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(BugReports)); });
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const rows = () => [...document.querySelectorAll('[data-slot="bug-report-row"]')].map((r) => r.textContent ?? '');

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('Your reports', () => {
  it('lists each report, newest first, with its state; a waiting one says why, a filed one links its issue', async () => {
    await render([]);
    expect(calls[0]).toEqual({ method: 'GET', path: '/api/bug-reports' });
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toContain('Queue stalls');
    expect(rows()[0]).toContain('Waiting to send');
    expect(rows()[0]).toContain('GitHub answered 403 to a new issue');
    expect(rows()[0]).toContain('Filed by job j7');
    expect(rows()[0]).toContain('Removed before sending, as private work: repository, commit id');
    expect(rows()[1]).not.toContain('Removed before sending');
    expect(rows()[1]).toContain('#12 Board hangs');
    expect(rows()[1]).toContain('Closed');
    const link = document.querySelectorAll('[data-slot="bug-report-row"]')[1]!.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://github.com/henningfutrell/hopper/issues/12');
  });

  it('refreshes: the kept reports sent, the states read again', async () => {
    await render([{ ...REPORTS[0], state: 'open', number: 13, url: 'https://github.com/henningfutrell/hopper/issues/13', problem: undefined }, REPORTS[1]]);
    const refresh = [...document.querySelectorAll('button')].find((b) => /Refresh/.test(b.textContent ?? ''))!;
    await act(async () => { refresh.click(); });
    for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(calls.at(-1)).toEqual({ method: 'POST', path: '/ui/api/bug-reports/refresh' });
    expect(rows()[0]).toContain('#13 Queue stalls');
    expect(rows()[0]).toContain('Open');
    expect(rows()[0]).not.toContain('Waiting');
  });

  it('says so when there are no reports', async () => {
    await render([], []);
    expect(document.body.textContent).toContain('No reports yet');
  });
});
