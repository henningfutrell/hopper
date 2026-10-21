// @vitest-environment happy-dom
// Issue #897 in the UI, against a fake of the daemon's HTTP surface: every decision that waits on a person has one top-level
// home, and Needs you, the first nav entry, gathers them with a count each. Intake holds the request cards (no Approve stays
// in Sources); Access requests holds what jobs on boxes wait for — credentials, vault grants, template approvals — (no
// Approve stays in Vault). Every one of these pages renders when nothing waits, and says what would show there.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { countStates } from '../../src/domain/work-items.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NEEDS_YOU_KINDS } from '../../ui/src/model/needs-you.ts';

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
  pending: { image: false, secrets: [], egress: [], profiles: [] }, radius: { level: 'low', reasons: ['reads only'], profiles: [] },
};
const VAULT = {
  secrets: [], backends: [], shared: [], readPolicy: [],
  templates: [TEMPLATE],
  requests: [{ id: 'r1', title: 'A kubeconfig', template: 'web', secret: 'KUBE', kinds: [{ id: 'kube', title: 'A kubeconfig' }], skill: 'kube', existing: [], asked: [{ job: 'f3b1c2d4-0000-4000-8000-000000000002', machine: 'box-1', at: '2026-10-11T12:00:00.000Z' }], setup: 'Ask the cluster admin.', known: true }],
  grantAsks: [{ job: 'f3b1c2d4-0000-4000-8000-000000000001', key: url(7), machine: 'box-1', template: 'web', names: ['KUBE_TOKEN'], askedAt: '2026-10-11T12:00:00.000Z' }],
  grants: [],
};
const PULL_REQUESTS = { yolo: { on: 1, total: 2 }, waiting: [], repos: [{ repo: 'octo-user/hopper', yolo: true, pullRequests: [
  { jobId: 'j-5', repo: 'octo-user/hopper', issue: { number: 5, url: url(5) }, pullRequest: { number: 6, url: 'https://github.com/octo-user/hopper/pull/6' }, part: false, state: 'open', checks: 'passing', mergeable: 'conflicts', draft: false, yolo: true, waits: 'conflicts', queue: { next: true } },
  { jobId: 'j-7', repo: 'octo-user/hopper', issue: { number: 7, url: url(7) }, pullRequest: { number: 8, url: 'https://github.com/octo-user/hopper/pull/8' }, part: false, state: 'open', checks: 'failing', mergeable: 'mergeable', draft: false, yolo: true, waits: 'checks failing', gaveUp: 'checks still fail after 3 fixes: a person must look at them' },
] }] };
const PLAN = {
  id: 'p1', tool: 'terraform', asset: { kind: 'aws-account', name: 'lab' }, target: 'lab', repo: 'octo-user/infra', ref: 'main', commit: 'c'.repeat(40),
  read: 'read', job: 'j-7', file: { size: 1, sha256: 'a'.repeat(64) }, createdAt: '2026-10-12T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
  approver: { who: 'admin', why: 'low risk, but not in uat only: in lab' },
};
const YOLO = { on: false, repos: { 'octo-user/hopper': true }, choices: { repos: ['octo-user/hopper', 'octo-user/infra'] } };
const PICK = {
  pickId: 'k1', at: '2026-10-12T00:00:00.000Z', point: 'merge-order', options: [{ id: 'a', label: 'First' }, { id: 'b', label: 'Second' }],
  pick: 'a', confidence: 0.9, mode: 'shadow', threshold: 0.85, applied: false, notApplied: 'shadow',
};
const POINT = { point: 'merge-order', label: 'Merge order', describe: 'Which pull request merges first.', mode: 'shadow', threshold: 0.85, asked: 1, picked: 1, applied: 0, compared: 0, agreed: 0, agreement: null, overridden: 0 };
const MINOR = { jev: { available: true }, typesafeKey: { set: true, last4: 'abcd' }, windowDays: 30, points: [POINT], recent: [PICK] };
const EMPTY_VAULT = { secrets: [], backends: [], shared: [], readPolicy: [], templates: [], requests: [], grantAsks: [], grants: [] };

const posts: { path: string; body: unknown }[] = [];
let sources: unknown[] = SOURCES;
let vault: unknown = VAULT;
let pullRequests: unknown = PULL_REQUESTS;
let plans: unknown = { plans: [PLAN], applies: [], settings: { autoApprove: false }, watchers: {} };
let minor: unknown = MINOR;
// Issue #1128: a machine whose tool is signed in as nobody waits on a sign-in.
const SIGNED_OUT = { accounts: [{ service: 'claude', detail: {}, login: 'signed-out', spend: [], machines: [{ machineId: 'm3', label: 'Server', source: 'claude-server', login: 'signed-out', signIn: true }] }] };
let toolAccounts: unknown = SIGNED_OUT;

function fakeDaemon() {
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    // The work-item ledger's counts (issue #1067) lag the source's card here: Intake's badge and row count the cards the page shows (issue #1193).
    '/api/queue': { waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [], locked: [], items: { ...countStates([]), waiting_for_approval: 0 } },
    '/api/machines': { machines: [] }, '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] }, '/api/questions': { questions: [] },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
    '/api/connected-accounts': { accounts: [{
      provider: 'github', key: 'github', via: 'the hopper\'s app', state: 'connected', account: 'octo-user', jobRepositories: ['octo-user/hopper'],
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
      if (path === '/ui/api/infra-plans') {
        const plan = { ...PLAN, approval: { plan: PLAN.id, by: 'admin', at: '2026-10-12T00:00:00.000Z' } };
        plans = { plans: [plan], applies: [], settings: { autoApprove: false }, watchers: {} };
        return json(200, { plan });
      }
      return json(200, path === '/ui/api/vault' ? { ...VAULT, templates: [{ ...TEMPLATE, approval: { by: 'admin', at: '2026-10-12T00:00:00.000Z', image: TEMPLATE.image, secrets: TEMPLATE.secrets } }] } : { done: [], failed: {} });
    }
    if (path === '/api/sources') return json(200, { sources });
    if (path === '/api/pull-requests') return json(200, pullRequests);
    if (path === '/api/infra-plans') return json(200, plans);
    if (path === '/api/yolo-mode') return json(200, YOLO);
    if (path === '/api/minor-decisions') return json(200, minor);
    if (path === '/api/tool-accounts') return json(200, toolAccounts);
    if (path === '/api/bug-reports') return json(200, { reports: [] });
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

async function boot(hash: string, o: { sources?: unknown[]; vault?: unknown; pullRequests?: unknown; plans?: unknown; minor?: unknown; toolAccounts?: unknown } = {}) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = hash;
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  posts.length = 0;
  sources = o.sources ?? SOURCES;
  vault = 'vault' in o ? o.vault : VAULT;
  pullRequests = o.pullRequests ?? PULL_REQUESTS;
  plans = o.plans ?? { plans: [PLAN], applies: [], settings: { autoApprove: false }, watchers: {} };
  minor = o.minor ?? MINOR;
  toolAccounts = o.toolAccounts ?? SIGNED_OUT;
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

describe('the nav: Dashboard, then Needs you, Intake and Access requests top-level, each with its count (issues #897, #951)', () => {
  it('the Dashboard is the first entry, Needs you the second, and Needs you counts every decision that waits', async () => {
    await boot('#dashboard');
    await vi.waitFor(() => expect(badge('#access-requests')).toBe('3'));
    expect([...document.querySelectorAll('nav a')].slice(0, 2).map((a) => a.getAttribute('href'))).toEqual(['#dashboard', '#needs-you']);
    expect(navLink('#dashboard')!.textContent).toBe('Dashboard');
    expect(navLink('#needs-you')!.textContent).toContain('Needs you');
    expect(badge('#intake')).toBe('1');
    await vi.waitFor(() => expect(badge('#needs-you')).toBe('7'));
    expect(navLink('#not-taken')).toBeNull();
  });

  it('Infra is badged with the plans that wait, Pull requests with the ones the hopper gave up on (issue #927)', async () => {
    await boot('#dashboard');
    await vi.waitFor(() => expect(badge('#pull-requests')).toBe('1'));
    await vi.waitFor(() => expect(badge('#infra')).toBe('1'));
    expect(navLink('#pull-requests')!.querySelector('[data-slot="nav-badge"]')!.getAttribute('title')).toBe('the hopper gave up on 1 pull request');
  });

  it('an approve on Infra takes the plan off the badge at once, not at the next read (issue #1193)', async () => {
    await boot('#infra');
    await vi.waitFor(() => expect(badge('#infra')).toBe('1'));
    const approve = await vi.waitFor(() => { const b = [...main().querySelectorAll('button')].find((x) => x.textContent?.trim() === 'Approve'); expect(b).toBeDefined(); return b!; });
    const reads = () => (fetch as unknown as { mock: { calls: [string, RequestInit?][] } }).mock.calls.filter(([u, i]) => String(u).startsWith('/api/infra-plans') && i?.method !== 'POST').length;
    const before = reads();
    await act(async () => { approve.click(); });
    await vi.waitFor(() => expect(badge('#infra')).toBeUndefined());
    expect(reads()).toBe(before);
  });

  it('no view in the link opens the Dashboard (issue #951)', async () => {
    await boot('');
    await vi.waitFor(() => expect(document.querySelector('[data-dashboard-panel]')).not.toBeNull());
    expect(navLink('#dashboard')!.getAttribute('aria-current')).toBe('page');
    expect(document.title).toBe('hopper');
  });

  it('an old #overview link opens the Dashboard (issue #951)', async () => {
    await boot('#overview');
    await vi.waitFor(() => expect(document.querySelector('[data-dashboard-panel]')).not.toBeNull());
    expect(navLink('#dashboard')!.getAttribute('aria-current')).toBe('page');
    expect(navLink('#overview')).toBeNull();
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
    await vi.waitFor(() => expect(row('plans')?.querySelector('[data-needs-you-count]')?.textContent).toBe('1'));
    expect(row('plans')!.querySelector('a')!.getAttribute('href')).toBe('#infra');
    await vi.waitFor(() => expect(row('pull-requests')?.querySelector('[data-needs-you-count]')?.textContent).toBe('1'));
    expect(row('pull-requests')!.querySelector('a')!.getAttribute('href')).toBe('#pull-requests');
    // Issue #927: why the hopper gave up shows under its row, not only on the card.
    expect(row('pull-requests')!.querySelector('[data-needs-you-detail]')!.textContent).toBe('octo-user/hopper#8: checks still fail after 3 fixes: a person must look at them');
    // Issue #1128: a signed-out tool shows as soon as its source reads it, and links to Accounts, where a person signs it in.
    await vi.waitFor(() => expect(row('accounts')?.querySelector('[data-needs-you-count]')?.textContent).toBe('1'));
    expect(row('accounts')!.querySelector('a')!.getAttribute('href')).toBe('#accounts');
    expect(row('accounts')!.querySelector('[data-needs-you-detail]')!.textContent).toBe('Claude on Server: signed in as nobody — sign it in from Accounts');
  });
});

describe('the header shows yolo mode on every screen, and links to its one switch (issue #897)', () => {
  it('says where it is on, and opens Settings → Yolo mode', async () => {
    await boot('#dashboard');
    const yolo = () => document.querySelector<HTMLAnchorElement>('header [data-yolo]');
    await vi.waitFor(() => expect(yolo()?.textContent).toBe('yolo on: 1 of 2 repos'));
    expect(yolo()!.getAttribute('href')).toBe('#settings/yolo-mode');
    expect(yolo()!.getAttribute('data-yolo')).toBe('on');
  });
});

describe('empty states: every page renders when nothing waits (issue #897)', () => {
  it('Needs you says nothing waits, and still lists what would show', async () => {
    await boot('#needs-you', { sources: [], vault: EMPTY_VAULT, pullRequests: { yolo: { on: 0, total: 0 }, waiting: [], repos: [] }, plans: { plans: [], applies: [] }, toolAccounts: { accounts: [] } });
    await vi.waitFor(() => expect(main().textContent).toContain('Nothing waits on you'));
    expect(document.querySelectorAll('[data-needs-you]').length).toBe(NEEDS_YOU_KINDS.length);
  });

  it('Intake with no source says what will show there', async () => {
    await boot('#intake', { sources: [] });
    await vi.waitFor(() => expect(document.querySelector('[data-intake-page]')).not.toBeNull());
    expect(main().textContent).toContain('No job source lists issues yet');
  });

  it('Access requests with nothing waiting shows each panel, with what will show there', async () => {
    await boot('#access-requests', { vault: EMPTY_VAULT });
    await vi.waitFor(() => expect(document.querySelectorAll('[data-access-panel]').length).toBe(7));
    for (const empty of ['No job asks for a credential', 'No job waits for a vault grant', 'No job waits for an AWS action', 'No template of yours waits for approval', 'No sandbox run waits', 'No template names a cluster the vault cannot find', 'No bastion runs']) expect(main().textContent).toContain(empty);
  });

  it('Access requests when the vault cannot be read says so, and still renders', async () => {
    await boot('#access-requests', { vault: undefined });
    await vi.waitFor(() => expect(document.querySelectorAll('[data-access-panel]').length).toBe(7));
  });
});

describe('one home each: no Approve stays in Sources or Vault (issue #897)', () => {
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

  it('Vault offers no Approve and no Grant, and links a waiting template to Access requests', async () => {
    await boot('#vault');
    await vi.waitFor(() => expect(main().textContent).toContain('ghcr.io/x/box:1'));
    for (const action of ['Approve', 'Grant', 'Give']) expect(buttons(main())).not.toContain(action);
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

describe('one home each: the decider\'s picks, the question history and Your reports leave Settings (issue #897)', () => {
  const settingsSections = () => [...document.querySelectorAll('[data-slot="settings-nav"] a')].map((a) => a.getAttribute('href'));

  // Issue #1169: a pick is a question form too — its options are the questionnaire's choices, Jev's pick checked.
  it('Decisions has the decider\'s picks, each a question form whose Override posts the choice checked', async () => {
    await boot('#decisions');
    const pick = () => document.querySelector<HTMLElement>('[data-pick="k1"]');
    const form = await vi.waitFor(() => { const f = pick()?.querySelector('[data-slot="questionnaire"][data-question-form="override"]'); expect(f).toBeTruthy(); return f!; });
    const choices = [...form.querySelectorAll<HTMLElement>('[data-slot="questionnaire-choice"]')];
    expect(choices.map((c) => c.textContent?.trim())).toEqual(['First', 'Second']);
    const radios = [...form.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((r) => r.checked)).toEqual([true, false]);
    expect(main().querySelector('a[href="#settings/decider"]')).not.toBeNull();
    await act(async () => { radios[1]!.click(); });
    await act(async () => { [...pick()!.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Override')!.click(); });
    await vi.waitFor(() => expect(posts).toContainEqual({ path: '/ui/api/minor-decisions/picks/k1/override', body: { actual: 'b' } }));
  });

  it('Decisions with no pick says what will show there', async () => {
    await boot('#decisions', { minor: { ...MINOR, recent: [] } });
    await vi.waitFor(() => expect(document.querySelector('[data-decider-picks]')).not.toBeNull());
    expect(main().textContent).toContain('No decider pick yet');
  });

  it('Settings → Decider keeps the configuration only, and links to the picks on Decisions', async () => {
    await boot('#settings/decider');
    await vi.waitFor(() => expect(document.querySelector('[data-point="merge-order"]')).not.toBeNull());
    expect(document.querySelector('[data-pick]')).toBeNull();
    expect(buttons(main())).not.toContain('Override');
    expect(main().querySelector('a[href="#decisions"]')).not.toBeNull();
  });

  it('Settings has no Question history and no Your reports', async () => {
    await boot('#settings/version');
    await vi.waitFor(() => expect(settingsSections().length).toBeGreaterThan(0));
    expect(settingsSections()).not.toContain('#settings/history');
    expect(settingsSections()).not.toContain('#settings/reports');
  });

  it('an old #settings/history link opens the question history on Questions', async () => {
    await boot('#settings/history');
    await vi.waitFor(() => expect(window.location.hash).toBe('#questions/history'));
    await vi.waitFor(() => expect(document.querySelector('[data-slot="question-history"]')).not.toBeNull());
  });

  it('Your reports is a top-level page; an old #settings/reports link opens it', async () => {
    await boot('#settings/reports');
    await vi.waitFor(() => expect(window.location.hash).toBe('#reports'));
    expect(navLink('#reports')!.textContent).toContain('Your reports');
    await vi.waitFor(() => expect(document.querySelector('[data-slot="bug-reports"]')).not.toBeNull());
  });
});
