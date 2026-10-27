// @vitest-environment happy-dom
// Your reports (issue #694), its own view (issue #897), rendered against a fake of the daemon's HTTP: each report with its state —
// waiting with why, open or closed with its link —, newest first; Refresh sends the kept ones and reads the states. The
// public warning, the admin's switch for public bug reports, and a job's report waiting for approval, with its text,
// Approve and Discard (issue #2818). The bug reports the completion reviews recommend, with Approve and Dismiss with why
// (issue #2846 part 2).
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

type El = ReturnType<typeof createElement>;
let root: Root | undefined;
let calls: { method: string; path: string; body?: unknown }[] = [];

const REPORTS = [
  { id: 'r2', createdAt: '2026-10-10T12:00:00.000Z', by: 'job j7', jobId: 'j7', fromJob: true, title: 'Queue stalls', state: 'waiting', kind: 'issue', problem: 'GitHub answered 403 to a new issue', removed: ['repository', 'commit id'], tries: 2 },
  { id: 'r1', createdAt: '2026-10-09T12:00:00.000Z', by: 'octocat', title: 'Board hangs', state: 'closed', kind: 'issue', number: 12, url: 'https://github.com/henningfutrell/hopper/issues/12', tries: 1 },
];

const APPROVAL = { id: 'r3', createdAt: '2026-10-11T12:00:00.000Z', by: 'job j8', jobId: 'j8', fromJob: true, title: 'Lane stalls', state: 'approval', kind: 'issue', body: '### Description\n\nThe lane stalls.', removed: ['host name'], tries: 0 };

const RECOMMENDED = { signature: 'cause:swept', title: 'The sweep stopped a job at work', description: 'The sweep stopped it.', jobId: 'j9', state: 'open', jobs: 2, at: '2026-10-11T12:00:00.000Z', lastAt: '2026-10-11T12:00:00.000Z' };

async function render(after: unknown[], list: unknown[] = REPORTS, o: { role?: string; publicReports?: boolean; recommended?: unknown[] } = {}) {
  calls = [];
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit = {}) => {
    calls.push({ method: init.method ?? 'GET', path: String(path), ...(init.body ? { body: JSON.parse(String(init.body)) as unknown } : {}) });
    if (path === '/ui/api/bug-reports/settings') return json({ publicReports: (JSON.parse(String(init.body)) as { on: boolean }).on });
    if (path === '/ui/api/bug-reports/approve') return json({ kind: 'filed', number: 14, url: 'https://github.com/henningfutrell/hopper/issues/14' });
    if (path === '/ui/api/bug-reports/discard') return json({ ok: true });
    if (path === '/api/completion-review/recommendations?state=open') return json({ recommendations: o.recommended ?? [] });
    if (path === '/ui/api/completion-review/recommendations/approve') return json({ kind: 'filed', number: 15, url: 'https://github.com/henningfutrell/hopper/issues/15' });
    if (path === '/ui/api/completion-review/recommendations/dismiss') return json({ ...RECOMMENDED, state: 'dismissed' });
    return json({ reports: path === '/ui/api/bug-reports/refresh' ? after : list, publicReports: o.publicReports ?? true });
  }));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  const view = '../../ui/src/views/bug-reports.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const store = '../../ui/src/store/index.ts';
  const { useHopper } = (await import(store)) as { useHopper: { setState(s: Record<string, unknown>): void } };
  useHopper.setState({ authed: true, user: { id: 'u1', name: 'ada', role: o.role ?? 'operator', realm: 'local', identity: 'ada' } });
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
    expect(calls).toContainEqual({ method: 'GET', path: '/api/bug-reports' });
    expect(document.querySelector('[data-slot="recommended-reports"]')).toBeNull();
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toContain('Queue stalls');
    expect(rows()[0]).toContain('Waiting to send');
    expect(rows()[0]).toContain('GitHub answered 403 to a new issue');
    expect(rows()[0]).toContain('Filed by job j7');
    expect(rows()[0]).toContain('Removed before sending: repository, commit id');
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
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/ui/api/bug-reports/refresh' });
    expect(rows()[0]).toContain('#13 Queue stalls');
    expect(rows()[0]).toContain('Open');
    expect(rows()[0]).not.toContain('Waiting');
  });

  it('shows the public warning, and lets only an admin turn public bug reports on (issue #2818)', async () => {
    await render([], [], { publicReports: false });
    expect(document.querySelector('[data-slot="bug-reports-warning"]')?.textContent).toContain('posted publicly on GitHub');
    const toggle = document.querySelector<HTMLButtonElement>('[aria-label="Public bug reports"]')!;
    expect(toggle.disabled).toBe(true);
    expect(document.body.textContent).toContain('Public bug reports are off');
    await act(async () => root?.unmount());
    await render([], [], { publicReports: false, role: 'admin' });
    const on = document.querySelector<HTMLButtonElement>('[aria-label="Public bug reports"]')!;
    expect(on.disabled).toBe(false);
    await act(async () => { on.click(); });
    for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/ui/api/bug-reports/settings', body: { on: true } });
    expect(document.body.textContent).toContain('Public bug reports are on');
  });

  it('shows a job\'s report that waits for approval with its text; Approve posts it, Discard drops it (issue #2818)', async () => {
    await render([], [APPROVAL, ...REPORTS]);
    const row = document.querySelector('[data-slot="bug-report-approval"]')!;
    expect(row.textContent).toContain('The lane stalls.');
    expect(rows()[0]).toContain('Waits for your approval');
    expect(rows()[0]).toContain('Removed before sending: host name');
    const press = async (text: RegExp) => {
      const b = [...row.querySelectorAll('button')].find((x) => text.test(x.textContent ?? ''))!;
      await act(async () => { b.click(); });
      for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    };
    await press(/Approve/);
    expect(calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/ui/api/bug-reports/approve', body: { id: 'r3' } }));
    await press(/Discard/);
    expect(calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/ui/api/bug-reports/discard', body: { id: 'r3' } }));
  });

  it('shows the reports the completion reviews recommend; Approve files one, Dismiss asks why (issue #2846 part 2)', async () => {
    await render([], [], { recommended: [RECOMMENDED] });
    const item = () => document.querySelector('[data-slot="recommended-report"]')!;
    expect(item().textContent).toContain('The sweep stopped a job at work');
    expect(item().textContent).toContain('found in 2 jobs');
    expect(item().querySelector('a')?.getAttribute('href')).toBe('#jobs/j9');
    const press = async (text: RegExp) => {
      const b = [...item().querySelectorAll('button')].find((x) => text.test(x.textContent ?? ''))!;
      await act(async () => { b.click(); });
      for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    };
    await press(/Approve/);
    expect(calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/ui/api/completion-review/recommendations/approve', body: { signature: 'cause:swept' } }));
    await press(/Dismiss…/);
    const dismiss = [...item().querySelectorAll('button')].find((x) => x.textContent === 'Dismiss')!;
    expect(dismiss.disabled).toBe(true); // no reason yet
    const input = item().querySelector<HTMLInputElement>('input[aria-label="Why dismiss it"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'fixed already');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { item().querySelector('form')!.requestSubmit(); });
    for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/ui/api/completion-review/recommendations/dismiss', body: { signature: 'cause:swept', reason: 'fixed already' } }));
  });

  it('says so when there are no reports', async () => {
    await render([], []);
    expect(document.body.textContent).toContain('No reports yet');
  });
});
