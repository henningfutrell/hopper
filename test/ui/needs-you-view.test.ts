// @vitest-environment happy-dom
// Issue #897 in the UI, against a fake of the daemon's HTTP surface: every decision that waits on a person has one top-level
// home, and Needs you, the first nav entry, gathers them with a count each. Intake holds the request cards (no Approve stays
// in Sources); Access requests holds what jobs on boxes wait for — credentials, vault grants, template approvals — (no
// Approve stays in Settings → Vault). Every one of these pages renders when nothing waits, and says what would show there.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const url = (n: number) => `https://github.com/octo-user/hopper/issues/${n}`;
const REQUEST = {
  hash: 'a'.repeat(64), title: 'Request 9', body: 'Please change it.', author: 'helper[bot]',
  actors: [{ role: 'author', login: 'helper[bot]', app: 'helper[bot]', trusted: false }], why: ['written by an app or a bot (helper[bot])'],
};
const SOURCES = [{
  name: 'github-account', kind: 'github-account', state: 'ok', itemsSeen: 2, jobsCreated: 1, activeJobs: 1,
  detail: { intake: [
    { key: url(1), title: 'Taken one', repo: 'octo-user/hopper', jobId: 'j-1', jobStatus: 'running' },
    { key: url(9), title: 'Request 9', repo: 'octo-user/hopper', reason: 'a request: approve it to take it', action: 'approve', group: 'request', request: REQUEST },
  ] },
}];
const TEMPLATE = {
  name: 'web', image: 'ghcr.io/x/box:1', secrets: ['KUBE_TOKEN'], profiles: [], tools: [], gives: [], limits: {},
  pending: { image: false, secrets: [], profiles: [] }, radius: { level: 'low', reasons: ['reads only'], profiles: [] },
};
const VAULT = {
  secrets: [], backends: [], shared: [], readPolicy: [],
  templates: [TEMPLATE],
  requests: [{ id: 'r1', title: 'A kubeconfig', template: 'web', secret: 'KUBE', kinds: [{ id: 'kube', title: 'A kubeconfig' }], skill: 'kube', existing: [], asked: [{ job: 'f3b1c2d4-0000-4000-8000-000000000002', machine: 'box-1', at: '2026-10-11T12:00:00.000Z' }], setup: 'Ask the cluster admin.', known: true }],
  grantAsks: [{ job: 'f3b1c2d4-0000-4000-8000-000000000001', key: url(7), machine: 'box-1', template: 'web', names: ['KUBE_TOKEN'], askedAt: '2026-10-11T12:00:00.000Z' }],
  grants: [],
};
const EMPTY_VAULT = { secrets: [], backends: [], shared: [], readPolicy: [], templates: [], requests: [], grantAsks: [], grants: [] };

const posts: { path: string; body: unknown }[] = [];
let sources: unknown[] = SOURCES;
let vault: unknown = VAULT;

function fakeDaemon() {
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [], locked: [] },
    '/api/machines': { machines: [] }, '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] }, '/api/questions': { questions: [] },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
    '/api/connected-accounts': { accounts: [{
      provider: 'github', via: 'the hopper\'s app', state: 'connected', account: 'octo-user', jobRepositories: ['octo-user/hopper'],
      installations: [{ account: 'octo-user', repositorySelection: 'all', repositories: ['octo-user/hopper'] }],
    }] },
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input).split('?')[0]!;
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'admin', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as unknown;
      posts.push({ path, body });
      return json(200, path === '/ui/api/vault' ? { ...VAULT, templates: [{ ...TEMPLATE, approval: { by: 'admin', at: '2026-10-12T00:00:00.000Z', image: TEMPLATE.image, secrets: TEMPLATE.secrets } }] } : { done: [], failed: {} });
    }
    if (path === '/api/sources') return json(200, { sources });
    if (path === '/api/vault') return vault === undefined ? json(404, { error: 'not found' }) : json(200, vault);
    return path in routes ? json(200, routes[path]) : json(404, { error: 'not found' });
  });
}

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

let root: Root | undefined;

async function boot(hash: string, o: { sources?: unknown[]; vault?: unknown } = {}) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = hash;
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  posts.length = 0;
  sources = o.sources ?? SOURCES;
  vault = 'vault' in o ? o.vault : VAULT;
  vi.stubGlobal('fetch', fakeDaemon());
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

const navLink = (hash: string) => document.querySelector<HTMLElement>(`nav a[href="${hash}"]`);
const badge = (hash: string) => navLink(hash)?.querySelector('[data-slot="nav-badge"]')?.textContent;
const buttons = (el: ParentNode) => [...el.querySelectorAll('button')].map((b) => b.textContent?.trim());
const main = () => document.querySelector('main')!;

describe('the nav: Needs you first, Intake and Access requests top-level, each with its count (issue #897)', () => {
  it('Needs you is the first entry and counts every decision that waits', async () => {
    await boot('#overview');
    await vi.waitFor(() => expect(badge('#access-requests')).toBe('3'));
    expect(document.querySelector('nav a')!.getAttribute('href')).toBe('#needs-you');
    expect(navLink('#needs-you')!.textContent).toContain('Needs you');
    expect(badge('#intake')).toBe('1');
    expect(badge('#needs-you')).toBe('4');
    expect(navLink('#not-taken')).toBeNull();
  });

  it('an old #not-taken link opens Intake', async () => {
    await boot('#not-taken');
    await vi.waitFor(() => expect(document.querySelector('[data-intake-page]')).not.toBeNull());
  });
});

describe('Needs you lists every kind with its count and links to its home (issue #897)', () => {
  it('each row links to its page', async () => {
    await boot('#needs-you');
    const row = (k: string) => document.querySelector<HTMLElement>(`[data-needs-you="${k}"]`);
    await vi.waitFor(() => expect(row('access')?.querySelector('[data-needs-you-count]')?.textContent).toBe('3'));
    expect(row('intake')!.querySelector('[data-needs-you-count]')!.textContent).toBe('1');
    expect(row('intake')!.querySelector('a')!.getAttribute('href')).toBe('#intake');
    expect(row('access')!.querySelector('a')!.getAttribute('href')).toBe('#access-requests');
    expect(row('questions')!.querySelector('[data-needs-you-count]')!.textContent).toBe('0');
  });
});

describe('empty states: every page renders when nothing waits (issue #897)', () => {
  it('Needs you says nothing waits, and still lists what would show', async () => {
    await boot('#needs-you', { sources: [], vault: EMPTY_VAULT });
    await vi.waitFor(() => expect(main().textContent).toContain('Nothing waits on you'));
    expect(document.querySelectorAll('[data-needs-you]').length).toBe(8);
  });

  it('Intake with no source says what will show there', async () => {
    await boot('#intake', { sources: [] });
    await vi.waitFor(() => expect(document.querySelector('[data-intake-page]')).not.toBeNull());
    expect(main().textContent).toContain('No job source lists issues yet');
  });

  it('Access requests with nothing waiting shows each panel, with what will show there', async () => {
    await boot('#access-requests', { vault: EMPTY_VAULT });
    await vi.waitFor(() => expect(document.querySelectorAll('[data-access-panel]').length).toBe(3));
    expect(main().textContent).toContain('No job asks for a credential');
    expect(main().textContent).toContain('No job waits for a vault grant');
    expect(main().textContent).toContain('No template waits for approval');
  });

  it('Access requests when the vault cannot be read says so, and still renders', async () => {
    await boot('#access-requests', { vault: undefined });
    await vi.waitFor(() => expect(document.querySelectorAll('[data-access-panel]').length).toBe(3));
  });
});

describe('one home each: no Approve stays in Sources or Settings → Vault (issue #897)', () => {
  it('Intake has the request card with Approve', async () => {
    await boot('#intake');
    const item = () => document.querySelector<HTMLElement>(`[data-intake-item="${url(9)}"]`);
    await vi.waitFor(() => expect(item()).not.toBeNull());
    expect(buttons(item()!)).toContain('Approve');
  });

  it('Sources links to Intake with the count, and offers no Approve', async () => {
    await boot('#sources');
    const link = () => document.querySelector<HTMLAnchorElement>('[data-intake-link="github-account"]');
    await vi.waitFor(() => expect(link()).not.toBeNull());
    expect(link()!.getAttribute('href')).toBe('#intake');
    expect(link()!.textContent).toContain('1 request waits for approval');
    expect(buttons(main())).not.toContain('Approve');
    expect(document.querySelector('[data-intake-item]')).toBeNull();
  });

  it('Settings → Vault offers no Approve and no Grant, and links a waiting template to Access requests', async () => {
    await boot('#settings/vault');
    await vi.waitFor(() => expect(main().textContent).toContain('ghcr.io/x/box:1'));
    expect(buttons(main())).not.toContain('Approve');
    expect(buttons(main())).not.toContain('Grant');
    expect(buttons(main())).not.toContain('Give');
    expect(main().querySelector('a[href="#access-requests"]')).not.toBeNull();
  });

  it('Access requests: Approve on a waiting template posts its approval', async () => {
    await boot('#access-requests');
    const panel = () => document.querySelector<HTMLElement>('[data-access-panel="templates"]');
    await vi.waitFor(() => expect(panel()?.textContent).toContain('web'));
    await act(async () => { [...panel()!.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Approve')!.click(); });
    const confirm = () => [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find((b) => b.textContent?.trim() === 'Approve');
    await vi.waitFor(() => expect(confirm()).toBeDefined());
    await act(async () => { confirm()!.click(); });
    await vi.waitFor(() => expect(posts).toEqual([{ path: '/ui/api/vault', body: { action: 'approve-template', name: 'web' } }]));
  });
});
