// @vitest-environment happy-dom
// Issue #991, rendered in happy-dom inside the whole app against a fake of the daemon's HTTP surface. Access requests,
// Sandbox runs: a run a job asked for waits with its job and template; Approve posts it after the confirm; Decline posts
// the reason; the approved runs are listed with who approved them; the nav badge counts the run that waits.
// Settings → Vault, Sandbox approvals: the toggles post what changed, and YOLO posts both.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const WAITING = {
  id: 'q1', jobId: 'f3b1c2d4-0000-4000-8000-000000000001', jobTitle: 'Check the AWS bill', jobUrl: 'https://github.com/acme/infra/issues/7', template: 'asked-3f2a9c1d0e4b', state: 'waiting', askedAt: '2026-10-13T10:00:00.000Z',
  purpose: 'Read the bill of the UAT account', plan: 'aws ce get-cost-and-usage',
};
const RUNNING = { id: 'q2', jobId: 'a1b2c3d4-0000-4000-8000-000000000002', template: 'asked-3f2a9c1d0e4b', state: 'approved', askedAt: '2026-10-13T09:00:00.000Z', approvedBy: 'skip sandbox approval' };
// Issue #655 part 13: Jev's sandbox check held this one for a person, with why.
const WAITING_2 = { ...WAITING, id: 'q3', jobId: 'c1b2c3d4-0000-4000-8000-000000000003', jobTitle: 'Read the cluster', template: 'asked-9a8b7c6d5e4f', jev: { state: 'held', reason: 'the job reaches a target it has no reason to know' } };
const WRITE = { operation: 'write', asset: { kind: 'aws-account', name: '123456789012' } };
const HIGH = {
  name: 'asked-0a1b2c3d4e5f', image: 'ghcr.io/henningfutrell/hopper:box-claude', secrets: [], profiles: [WRITE], gives: [], savedBy: 'job j', savedAt: '2026-10-13T09:00:00.000Z',
  pending: { secrets: [], image: true, egress: [], profiles: [WRITE] }, radius: { level: 'high', reasons: ['write on aws-account 123456789012: it changes the asset'], profiles: [] },
  askedBy: 'f3b1c2d4-0000-4000-8000-000000000001', purpose: 'Create the cluster role for X in identity namespace', plan: 'kubectl apply -f role.yaml: ClusterRole x-reader. Undo: kubectl delete clusterrole x-reader.',
  label: 'create-the-cluster-role-for-x', askedByJob: { id: 'f3b1c2d4-0000-4000-8000-000000000001', title: 'Give X a role', url: 'https://github.com/acme/infra/issues/7' },
};
const MINTS = { id: 's1', name: 'AWS_UAT2', scope: 'gss-uat2 account', mints: { kind: 'aws-account', name: '123456789012' }, setBy: 'Ada', createdAt: '2026-10-01T00:00:00.000Z', changedBy: 'Ada', changedAt: '2026-10-01T00:00:00.000Z' };
const REMEMBERED = { ...WRITE, by: 'Ada', at: '2026-10-13T08:00:00.000Z', expiresAt: '2026-10-20T08:00:00.000Z' };
const VIEW = { secrets: [MINTS], templates: [HIGH], sandboxRequests: [WAITING, WAITING_2, RUNNING], sandboxApprovals: { skipTemplateApproval: false, skipSandboxApproval: false }, rememberedWrites: [REMEMBERED] };

interface Call { path: string; method: string; body?: Record<string, unknown> }

function fakeDaemon(o: { hold?: boolean; holdVault?: boolean; refuse?: string } = {}) {
  const calls: Call[] = [];
  let release = (): void => {};
  const held = new Promise<void>((r) => { release = r; });
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [], locked: [] },
    '/api/machines': { machines: [] }, '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] }, '/api/questions': { questions: [] },
    '/api/sources': { sources: [] }, '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
    '/api/vault': VIEW,
  };
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = String(input).split('?')[0]!;
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ path, method: init.method ?? 'GET', ...(body ? { body } : {}) });
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'admin', realm: 'github', name: 'alice', instanceAdmin: true }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (path === '/ui/api/sandbox-requests' && body?.id === o.refuse) return json(409, { error: `sandbox request ${o.refuse} is starting, not waiting` });
    if (path === '/ui/api/sandbox-requests' && o.hold) { await held; return json(200, VIEW); }
    if (path === '/ui/api/vault' && o.holdVault) { await held; return json(200, VIEW); }
    if (path === '/ui/api/sandbox-requests' || path === '/ui/api/sandbox-approvals' || path === '/ui/api/vault') return json(200, VIEW);
    if (path in routes) return json(200, routes[path]);
    return json(404, { error: 'not found' });
  });
  return { fetch, calls, release: () => release() };
}

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

let root: Root | undefined;

async function boot(hash: string, ready: () => unknown, o: { hold?: boolean; holdVault?: boolean; refuse?: string } = {}) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = hash;
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const daemon = fakeDaemon(o);
  vi.stubGlobal('fetch', daemon.fetch);
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(ready()).toBeTruthy());
  return daemon;
}

const runs = (): HTMLElement | null => document.querySelector('[data-access-panel="sandbox-runs"]');
const approvals = (): HTMLElement | null => document.querySelector('[data-slot="sandbox-approvals"]');
const buttonIn = (el: ParentNode, text: string): HTMLButtonElement => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)! as HTMLButtonElement;

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('Access requests: sandbox runs (issue #991)', () => {
  it('shows the run that waits with its job and template; Approve posts it after the confirm; the approved run says who approved it', async () => {
    const daemon = await boot('#access-requests', runs);
    const panel = runs()!;
    expect(panel.textContent).toContain('asked-3f2a9c1d0e4b');
    expect(panel.textContent).toContain('Check the AWS bill');
    expect(panel.textContent).toContain('approved: each step runs in a sandbox of its own, approved by skip sandbox approval');
    await act(async () => { buttonIn(panel, 'Approve').click(); });
    const confirm = () => [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find((b) => b.textContent?.trim() === 'Approve');
    await vi.waitFor(() => expect(confirm()).toBeDefined());
    await act(async () => { confirm()!.click(); });
    await vi.waitFor(() => expect(daemon.calls.find((x) => x.path === '/ui/api/sandbox-requests')).toBeDefined());
    expect(daemon.calls.find((x) => x.path === '/ui/api/sandbox-requests')!.body).toEqual({ action: 'approve', id: 'q1' });
  });

  it('Decline needs a reason, then posts it', async () => {
    const daemon = await boot('#access-requests', runs);
    const panel = runs()!;
    expect(buttonIn(panel, 'Decline').disabled).toBe(true);
    await type(panel.querySelector<HTMLInputElement>('input[placeholder="Why not (the job is told)"]')!, 'use the lab account');
    await act(async () => { buttonIn(runs()!, 'Decline').click(); });
    await vi.waitFor(() => expect(daemon.calls.find((x) => x.path === '/ui/api/sandbox-requests')).toBeDefined());
    expect(daemon.calls.find((x) => x.path === '/ui/api/sandbox-requests')!.body).toEqual({ action: 'decline', id: 'q1', reason: 'use the lab account' });
  });
});

describe('Settings → Vault: sandbox approvals (issue #991)', () => {
  it('says a person approves each; YOLO posts both on; a toggle posts itself', async () => {
    const daemon = await boot('#settings/vault', approvals);
    const panel = approvals()!;
    expect(panel.textContent).toContain('Templates and runs of low blast radius are approved with no person. A person approves each other new template and sandbox run.');
    await act(async () => { panel.querySelector<HTMLButtonElement>('[aria-label="YOLO"]')!.click(); });
    await vi.waitFor(() => expect(daemon.calls.find((x) => x.path === '/ui/api/sandbox-approvals')).toBeDefined());
    expect(daemon.calls.find((x) => x.path === '/ui/api/sandbox-approvals')!.body).toEqual({ yolo: true });
    await act(async () => { approvals()!.querySelector<HTMLButtonElement>('[aria-label="Skip sandbox approval"]')!.click(); });
    await vi.waitFor(() => expect(daemon.calls.filter((x) => x.path === '/ui/api/sandbox-approvals')).toHaveLength(2));
    expect(daemon.calls.filter((x) => x.path === '/ui/api/sandbox-approvals')[1]!.body).toEqual({ skipSandboxApproval: true });
  });
});

const confirmed = async (): Promise<void> => {
  const confirm = () => [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find((b) => /^Approve/.test(b.textContent?.trim() ?? ''));
  await vi.waitFor(() => expect(confirm()).toBeDefined());
  await act(async () => { confirm()!.click(); });
};
const card = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-sandbox-request="${id}"]`)!;

describe('approvals that do not block each other (issue #1001)', () => {
  it('while one approval is pending, the other cards stay clickable, and only that card shows its progress', async () => {
    const daemon = await boot('#access-requests', runs, { hold: true });
    await act(async () => { buttonIn(card('q1'), 'Approve').click(); });
    await confirmed();
    await vi.waitFor(() => expect(card('q1').textContent).toContain('Approving…'));
    expect(buttonIn(card('q3'), 'Approve').disabled).toBe(false);
    expect(card('q3').textContent).not.toContain('Approving…');
    await act(async () => { buttonIn(card('q3'), 'Approve').click(); });
    await confirmed();
    await vi.waitFor(() => expect(daemon.calls.filter((x) => x.path === '/ui/api/sandbox-requests')).toHaveLength(2));
    expect(daemon.calls.filter((x) => x.path === '/ui/api/sandbox-requests').map((x) => x.body)).toEqual([{ action: 'approve', id: 'q1' }, { action: 'approve', id: 'q3' }]);
    await act(async () => { daemon.release(); });
  });

  it('a high-radius template shows one Approve all listed action that approves the template and each listed profile', async () => {
    const daemon = await boot('#access-requests', () => document.querySelector(`[data-template-approval="${HIGH.name}"]`));
    const t = document.querySelector<HTMLElement>(`[data-template-approval="${HIGH.name}"]`)!;
    const labels = [...t.querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(labels).toEqual(['Approve all listed']);
    await act(async () => { buttonIn(t, 'Approve all listed').click(); });
    await confirmed();
    await vi.waitFor(() => expect(daemon.calls.filter((x) => x.path === '/ui/api/vault')).toHaveLength(2));
    expect(daemon.calls.filter((x) => x.path === '/ui/api/vault').map((x) => x.body)).toEqual([
      { action: 'approve-template', name: HIGH.name },
      { action: 'approve-profile', name: HIGH.name, ...WRITE },
    ]);
  });
});

describe('approve several at once (issue #1018)', () => {
  const template = (): HTMLElement => document.querySelector<HTMLElement>(`[data-template-approval="${HIGH.name}"]`)!;
  const select = async (el: HTMLElement): Promise<void> => { await act(async () => { el.querySelector<HTMLInputElement>('input[type="checkbox"][data-slot="select"]')!.click(); }); };
  const bar = (): HTMLElement => document.querySelector<HTMLElement>('[data-slot="approve-selected"]')!;

  it('Approve all listed sends the template and its profile side by side: the second does not wait for the first', async () => {
    const daemon = await boot('#access-requests', template, { holdVault: true });
    await act(async () => { buttonIn(template(), 'Approve all listed').click(); });
    await confirmed();
    await vi.waitFor(() => expect(daemon.calls.filter((x) => x.path === '/ui/api/vault')).toHaveLength(2));
    await act(async () => { daemon.release(); });
  });

  it('one Approve selected sends every selected approval at once; each card shows its own progress, then its result', async () => {
    const daemon = await boot('#access-requests', runs, { hold: true, holdVault: true });
    expect(buttonIn(bar(), 'Approve selected').disabled).toBe(true);
    await select(card('q1'));
    await select(card('q3'));
    await select(template());
    await act(async () => { buttonIn(bar(), 'Approve selected (3)').click(); });
    await confirmed();
    // Every approval is on the wire while none has answered.
    await vi.waitFor(() => expect(daemon.calls.filter((x) => x.path === '/ui/api/sandbox-requests' || x.path === '/ui/api/vault')).toHaveLength(4));
    expect(daemon.calls.filter((x) => x.path === '/ui/api/sandbox-requests').map((x) => x.body)).toEqual([{ action: 'approve', id: 'q1' }, { action: 'approve', id: 'q3' }]);
    expect(daemon.calls.filter((x) => x.path === '/ui/api/vault').map((x) => x.body)).toEqual([
      { action: 'approve-template', name: HIGH.name },
      { action: 'approve-profile', name: HIGH.name, ...WRITE },
    ]);
    for (const el of [card('q1'), card('q3'), template()]) expect(el.textContent).toContain('Approving…');
    await act(async () => { daemon.release(); });
    await vi.waitFor(() => expect(card('q1').textContent).toContain('Approved'));
    expect(card('q3').textContent).toContain('Approved');
    expect(template().textContent).toContain('Approved');
    expect(bar().textContent).toContain('3 approved');
  });

  it('a failure on one does not stop the rest: the others are approved, and the one that failed says why', async () => {
    const daemon = await boot('#access-requests', runs, { refuse: 'q1' });
    await act(async () => { buttonIn(bar(), 'Select all waiting').click(); });
    await act(async () => { buttonIn(bar(), 'Approve selected (3)').click(); });
    await confirmed();
    await vi.waitFor(() => expect(card('q1').textContent).toContain('sandbox request q1 is starting, not waiting'));
    await vi.waitFor(() => expect(card('q3').textContent).toContain('Approved'));
    expect(template().textContent).toContain('Approved');
    expect(daemon.calls.filter((x) => x.path === '/ui/api/sandbox-requests' || x.path === '/ui/api/vault')).toHaveLength(4);
    expect(bar().textContent).toContain('2 approved, 1 failed');
  });
});

describe('Settings → Vault: the auto-approve policy (issue #1001)', () => {
  it('shows low on and medium and high off by default; a level posts itself', async () => {
    const daemon = await boot('#settings/vault', approvals);
    const sw = (level: string) => approvals()!.querySelector<HTMLButtonElement>(`[aria-label="Auto-approve ${level} radius"]`)!;
    expect(sw('low').getAttribute('aria-checked')).toBe('true');
    expect(sw('medium').getAttribute('aria-checked')).toBe('false');
    expect(sw('high').getAttribute('aria-checked')).toBe('false');
    await act(async () => { sw('medium').click(); });
    await vi.waitFor(() => expect(daemon.calls.find((x) => x.path === '/ui/api/sandbox-approvals')).toBeDefined());
    expect(daemon.calls.find((x) => x.path === '/ui/api/sandbox-approvals')!.body).toEqual({ autoApprove: { medium: true } });
  });
});

describe('Settings → Vault: the standing read grant (issue #1472)', () => {
  it('shows it off by default; the switch posts itself', async () => {
    const daemon = await boot('#settings/vault', approvals);
    const sw = approvals()!.querySelector<HTMLButtonElement>('[aria-label="Standing read grant"]')!;
    expect(sw.getAttribute('aria-checked')).toBe('false');
    await act(async () => { sw.click(); });
    await vi.waitFor(() => expect(daemon.calls.find((x) => x.path === '/ui/api/sandbox-approvals')).toBeDefined());
    expect(daemon.calls.find((x) => x.path === '/ui/api/sandbox-approvals')!.body).toEqual({ standingReadGrant: true });
  });
});

describe('cards that say what the sandbox is for (issue #1001)', () => {
  it('a template card shows why, the job with its link, the plan, each asset in plain words and a readable name first', async () => {
    await boot('#access-requests', () => document.querySelector(`[data-template-approval="${HIGH.name}"]`));
    const t = document.querySelector<HTMLElement>(`[data-template-approval="${HIGH.name}"]`)!;
    expect(t.querySelector('[data-slot="template-label"]')!.textContent).toBe('create-the-cluster-role-for-x');
    expect(t.textContent).toContain(HIGH.name);
    expect(t.querySelector('[data-slot="why"]')!.textContent).toContain('Create the cluster role for X in identity namespace');
    const job = t.querySelector<HTMLAnchorElement>('[data-slot="job"] a[href^="https://"]')!;
    expect(job.href).toBe('https://github.com/acme/infra/issues/7');
    expect(t.querySelector('[data-slot="job"]')!.textContent).toContain('Give X a role');
    expect(t.querySelector('[data-slot="plan"]')!.textContent).toContain('Undo: kubectl delete clusterrole x-reader.');
    expect(t.querySelector('[data-slot="needs"]')!.textContent).toContain('write on aws-account 123456789012 (AWS_UAT2: gss-uat2 account): changes it');
  });

  it('a run card shows why, the job with its link, and the plan', async () => {
    await boot('#access-requests', runs);
    const c = card('q1');
    expect(c.querySelector('[data-slot="why"]')!.textContent).toContain('Read the bill of the UAT account');
    expect(c.querySelector<HTMLAnchorElement>('[data-slot="job"] a[href^="https://"]')!.href).toBe('https://github.com/acme/infra/issues/7');
    expect(c.querySelector('[data-slot="plan"]')!.textContent).toContain('aws ce get-cost-and-usage');
  });
});

describe('Settings → Vault: remembered write approvals (issue #1001)', () => {
  it('lists each remembered write with its end; Forget posts it; the time limit posts itself', async () => {
    const daemon = await boot('#settings/vault', approvals);
    const row = approvals()!.querySelector<HTMLElement>('[data-remembered-write="write/aws-account/123456789012"]')!;
    expect(row.textContent).toContain('write on aws-account 123456789012');
    expect(row.textContent).toContain('Ada');
    await act(async () => { buttonIn(row, 'Forget').click(); });
    await vi.waitFor(() => expect(daemon.calls.find((x) => x.path === '/ui/api/sandbox-approvals')).toBeDefined());
    expect(daemon.calls.find((x) => x.path === '/ui/api/sandbox-approvals')!.body).toEqual({ forgetWrite: WRITE });
    const hours = approvals()!.querySelector<HTMLInputElement>('input[aria-label="Remember write approvals for (hours)"]')!;
    expect(hours.value).toBe('168');
    await type(hours, '24');
    await act(async () => { buttonIn(approvals()!, 'Save time limit').click(); });
    await vi.waitFor(() => expect(daemon.calls.filter((x) => x.path === '/ui/api/sandbox-approvals')).toHaveLength(2));
    expect(daemon.calls.filter((x) => x.path === '/ui/api/sandbox-approvals')[1]!.body).toEqual({ rememberWritesHours: 24 });
  });
});

describe('Jev\'s sandbox check on a waiting run (issue #655 part 13)', () => {
  it('a run Jev held says so, with why; one Jev did not check says nothing of Jev', async () => {
    await boot('#access-requests', runs);
    expect(card('q3').querySelector('[data-slot="sandbox-request-jev"]')?.textContent).toBe('Jev held it for a person: the job reaches a target it has no reason to know.');
    expect(card('q1').querySelector('[data-slot="sandbox-request-jev"]')).toBeNull();
  });
});
