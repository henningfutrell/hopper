// @vitest-environment happy-dom
// Pending approvals in the UI (issue #2088): the page against a fake of GET /api/pending-approvals — one row per waiting
// run with its repository, workflow, title, environments, how long it waited and its link, a stale one marked —, its empty
// state, which says what would show there, and the count on its nav entry, rendered inside the whole app. What could not be
// read is one collapsed line with its count, each place behind its toggle (issue #2258).
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PendingApprovalsView } from '../../src/domain/types.ts';

const VIEW: PendingApprovalsView = {
  orgs: ['acme', 'platform-co'], checkedAt: '2026-10-19T12:00:00.000Z',
  approvals: [
    { repo: 'acme/gss', runId: 9, workflow: 'promote', title: 'Promote build 9', environments: ['production-approval'], waitingSince: '2026-10-19T09:00:00Z', url: 'https://github.com/acme/gss/actions/runs/9', stale: false },
    { repo: 'acme/gss', runId: 5, workflow: 'promote', title: 'Promote build 5', environments: ['production-approval'], waitingSince: '2026-10-08T10:00:00Z', url: 'https://github.com/acme/gss/actions/runs/5', stale: true },
  ],
  problems: [
    { where: 'platform-co/infra', error: 'GitHub answered 403 to platform-co/infra: Resource not accessible by integration' },
    { where: 'platform-co/web', error: 'GitHub answered 502 to platform-co/web: Bad Gateway' },
  ],
};
const EMPTY: PendingApprovalsView = { orgs: ['acme'], checkedAt: '2026-10-19T12:00:00.000Z', approvals: [], problems: [] };

let root: Root | undefined;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

async function bootView(answer: unknown) {
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', vi.fn(async (input: string) => json(String(input).split('?')[0] === '/api/pending-approvals' ? answer : {})));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  // Imported by a path in a variable: the UI's modules are typed by the UI's own tsconfig, not this one.
  const store = '../../ui/src/store/index.ts';
  const view = '../../ui/src/views/pending-approvals.tsx';
  const { useHopper } = (await import(store)) as { useHopper: { setState(s: unknown): void } };
  useHopper.setState({ authed: true, user: { role: 'viewer', realm: 'local', name: 'someone' } });
  const { PendingApprovals } = (await import(view)) as { PendingApprovals: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(PendingApprovals)); });
  await settle();
}

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

async function bootApp(answer: unknown) {
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = String(input).split('?')[0]!;
    if (path === '/ui/api/session') return json({ authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'admin', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (path === '/api/pending-approvals') return json(answer);
    if (path === '/api/health') return json({ ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 });
    return json({ error: 'not found' }, 404);
  }));
  vi.stubGlobal('EventSource', FakeEventSource);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#dashboard';
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

describe('the Pending approvals page', () => {
  it('one row per waiting run: repository, workflow, title, environment, waiting since, and a link to the run', async () => {
    await bootView(VIEW);
    const rows = [...document.querySelectorAll('[data-slot="pending-approval"]')];
    expect(rows).toHaveLength(2);
    const first = rows[0]!;
    for (const text of ['acme/gss', 'promote', 'Promote build 9', 'production-approval']) expect(first.textContent).toContain(text);
    expect(first.querySelector('[data-slot="pending-approval-since"]')?.getAttribute('title')).toBe('2026-10-19T09:00:00Z');
    const link = first.querySelector('a[href="https://github.com/acme/gss/actions/runs/9"]')!;
    expect(link.getAttribute('target')).toBe('_blank');
    expect(first.querySelector('[data-slot="pending-approval-stale"]')).toBeNull();
    const stale = rows[1]!.querySelector('[data-slot="pending-approval-stale"]')!;
    expect(stale.textContent).toMatch(/stale/i);
    expect(stale.textContent).toMatch(/newer run/i);
    expect(stale.getAttribute('title')).toMatch(/newer run of this repository waits on the same environment/i);
  });

  it('says the orgs it reads, when, and what could not be read as one collapsed line with its count; it offers no approve or reject', async () => {
    await bootView(VIEW);
    const page = document.getElementById('root')!;
    expect(page.querySelector('[data-slot="pending-approvals-orgs"]')?.textContent).toContain('acme, platform-co');
    const problems = page.querySelector<HTMLDetailsElement>('details[data-slot="pending-approvals-problems"]')!;
    expect(problems.open).toBe(false);
    expect(problems.querySelector('summary')?.textContent).toBe('2 repositories could not be checked');
    expect(problems.querySelectorAll('li')).toHaveLength(2);
    expect(problems.querySelector('li')?.textContent).toContain('platform-co/infra');
    expect([...page.querySelectorAll('button')].map((b) => b.textContent ?? '').filter((t) => /approve|reject/i.test(t))).toEqual([]);
  });

  it('a connected account that could not be read counts as one place, not a repository', async () => {
    await bootView({ ...EMPTY, problems: [{ where: 'github', error: 'GitHub is not connected' }] });
    expect(document.querySelector('[data-slot="pending-approvals-problems"] summary')?.textContent).toBe('1 account or repository could not be checked');
  });

  it('nothing missing shows no problems line', async () => {
    await bootView(EMPTY);
    expect(document.querySelector('[data-slot="pending-approvals-problems"]')).toBeNull();
  });

  it('empty: says nothing waits, and what would show here', async () => {
    await bootView(EMPTY);
    const empty = document.querySelector('[data-slot="pending-approvals-empty"]')!;
    expect(empty.textContent).toMatch(/Nothing waits on you/);
    expect(empty.textContent).toMatch(/GitHub Actions run/);
    expect(empty.textContent).toMatch(/deployment/);
    expect(empty.textContent).toMatch(/never approves/);
    expect(document.querySelectorAll('[data-slot="pending-approval"]')).toHaveLength(0);
  });

  it('an answer that is no view shows that it could not be read, and does not throw', async () => {
    await bootView({});
    expect(document.getElementById('root')!.textContent).toMatch(/could not/i);
  });
});

describe('the Approvals nav entry (issue #2374: it holds Pending approvals)', () => {
  it('is in Waiting on you, with the count of pending approvals', async () => {
    await bootApp(VIEW);
    const link = await vi.waitFor(() => { const a = document.querySelector('aside a[href="#approvals"]'); expect(a).not.toBeNull(); return a!; });
    expect(link.closest('[data-nav-group]')?.getAttribute('data-nav-group')).toBe('waiting');
    await vi.waitFor(() => expect(link.querySelector('[data-slot="nav-badge"]')?.textContent).toBe('2'));
    expect(link.querySelector('[data-slot="nav-badge"]')?.getAttribute('title')).toBe('2 deployment approvals wait on you (1 stale)');
  });

  it('shows no count when nothing waits', async () => {
    await bootApp(EMPTY);
    const link = await vi.waitFor(() => { const a = document.querySelector('aside a[href="#approvals"]'); expect(a).not.toBeNull(); return a!; });
    await settle();
    expect(link.querySelector('[data-slot="nav-badge"]')).toBeNull();
  });
});
