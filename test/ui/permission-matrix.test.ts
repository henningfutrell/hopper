// @vitest-environment happy-dom
// Settings → Permission matrix (issue #559): who may do what on which asset, read from GET /api/access. Rows are the
// templates with their machines, or the live jobs; columns are the assets, grouped by kind; each cell the operations
// approved, and those that wait for approval shown apart. A click on a cell says why — the steps from the row to the
// template, then the relationship chain, who approved it and when — and revokes from there. Filters: asset kind,
// operation, a name, and only the rows with access. Rendered in happy-dom inside the whole app against a fake daemon.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALL, permissionMatrix, rowSteps, type MatrixFilter } from '../../ui/src/model/permission-matrix.ts';
import type { AccessView } from '../../src/domain/types.ts';

const X = { kind: 'cluster', name: 'x' } as const;
const PROD = { kind: 'aws-account', name: '123456789012' } as const;
const tuple = (template: string, op: string, kind: string, name: string) => [
  { subject: `template:${template}`, relation: 'approved_for', object: `operation_profile:${op}/${kind}/${name}` },
  { subject: `operation_profile:${op}/${kind}/${name}`, relation: `grants_${op}`, object: `asset:${kind}/${name}` },
];
const approval = (id: number, template: string, operation: 'read' | 'write' | 'sync' | 'apply', asset: { kind: 'cluster' | 'aws-account'; name: string }) =>
  ({ id, template, profile: { operation, asset }, approvedBy: 'alice', approvedAt: '2026-10-09T11:30:00.000Z', chain: tuple(template, operation, asset.kind, asset.name) });
const low = { level: 'low' as const, reasons: [], profiles: [] };

const VIEW: AccessView = {
  status: { state: 'connected', syncedAt: '2026-10-09T12:00:00.000Z' },
  model: { version: 1, dsl: 'model\n', writtenBy: 'hopper', writtenAt: '2026-10-09T11:00:00.000Z' },
  templates: [
    { template: 'aws-diag', approvals: [approval(9, 'aws-diag', 'read', PROD)], radius: { level: 'medium', reasons: ['a vault secret'], profiles: [] } },
    { template: 'kubectl-diag', approvals: [approval(7, 'kubectl-diag', 'read', X)], radius: {
      level: 'high', reasons: ['write on cluster x: it changes the asset; waits for an explicit approval'],
      profiles: [{ profile: { operation: 'read', asset: X }, level: 'low', approved: true }, { profile: { operation: 'write', asset: X }, level: 'high', approved: false }],
    } },
    { template: 'unused', approvals: [], radius: low },
  ],
  holders: {
    machines: [{ user: 'admin', machine: 'box-kube', template: 'kubectl-diag' }],
    jobs: [{ user: 'admin', job: 'j-123', machine: 'box-kube', template: 'kubectl-diag', status: 'running' }],
  },
  revoked: [],
  decisions: [],
};

const filter = (f: Partial<MatrixFilter> = {}): MatrixFilter => ({ rows: 'templates', kind: ALL, operation: ALL, search: '', onlyWithAccess: false, ...f });

describe('the permission matrix model', () => {
  it('rows: each template, then its machines; columns: every asset approved or waiting, grouped by kind', () => {
    const m = permissionMatrix(VIEW, filter());
    expect(m.rows.map((r) => `${r.kind}:${r.label}`)).toEqual(['template:aws-diag', 'template:kubectl-diag', 'machine:box-kube', 'template:unused']);
    expect(m.groups.map((g) => [g.kind, g.columns.map((c) => c.asset.name)])).toEqual([['cluster', ['x']], ['aws-account', ['123456789012']]]);
  });

  it('a cell holds the approved operations and, apart, those that wait; a machine has its template\'s', () => {
    const m = permissionMatrix(VIEW, filter());
    const x = m.groups[0]!.columns[0]!;
    const kube = m.rows.find((r) => r.label === 'kubectl-diag')!;
    expect(m.cell(kube, x).approved.map((a) => a.id)).toEqual([7]);
    expect(m.cell(kube, x).pending).toEqual([{ operation: 'write', asset: X }]);
    expect(m.cell(m.rows.find((r) => r.kind === 'machine')!, x).approved.map((a) => a.id)).toEqual([7]);
    expect(m.cell(m.rows.find((r) => r.label === 'aws-diag')!, x)).toEqual({ approved: [], pending: [] });
  });

  it('the jobs view has one row per live job, with its template\'s cells', () => {
    const m = permissionMatrix(VIEW, filter({ rows: 'jobs' }));
    expect(m.rows.map((r) => [r.kind, r.job, r.machine, r.template])).toEqual([['job', 'j-123', 'box-kube', 'kubectl-diag']]);
    expect(m.cell(m.rows[0]!, m.groups[0]!.columns[0]!).approved.map((a) => a.id)).toEqual([7]);
  });

  it('filters by asset kind, operation, name, and only the rows with access', () => {
    expect(permissionMatrix(VIEW, filter({ kind: 'aws-account' })).groups.map((g) => g.kind)).toEqual(['aws-account']);
    const writes = permissionMatrix(VIEW, filter({ operation: 'write' }));
    expect(writes.groups.flatMap((g) => g.columns.map((c) => c.asset.name))).toEqual(['x']);
    expect(writes.cell(writes.rows.find((r) => r.label === 'kubectl-diag')!, writes.groups[0]!.columns[0]!)).toEqual({ approved: [], pending: [{ operation: 'write', asset: X }] });
    expect(permissionMatrix(VIEW, filter({ search: 'box' })).rows.map((r) => r.label)).toEqual(['box-kube']);
    expect(permissionMatrix(VIEW, filter({ onlyWithAccess: true })).rows.map((r) => r.label)).toEqual(['aws-diag', 'kubectl-diag', 'box-kube']);
    expect(permissionMatrix(VIEW, filter({ onlyWithAccess: true, operation: 'write' })).rows).toEqual([]);
  });

  it('says how a row reaches its template', () => {
    const [job] = permissionMatrix(VIEW, filter({ rows: 'jobs' })).rows;
    expect(rowSteps(job!)).toEqual(['job j-123 runs on machine box-kube', 'machine box-kube joined as a box of template kubectl-diag']);
    const machine = permissionMatrix(VIEW, filter()).rows.find((r) => r.kind === 'machine')!;
    expect(rowSteps(machine)).toEqual(['machine box-kube joined as a box of template kubectl-diag']);
  });
});

interface Call { path: string; method: string; body?: Record<string, unknown> }

function fakeDaemon(view: AccessView) {
  const calls: Call[] = [];
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [], locked: [] },
    '/api/machines': { machines: [] }, '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] }, '/api/questions': { questions: [] },
    '/api/sources': { sources: [] }, '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
    '/api/access': view,
  };
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = String(input).split('?')[0]!;
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ path, method: init.method ?? 'GET', ...(body ? { body } : {}) });
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'admin', realm: 'github', name: 'alice', instanceAdmin: true }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (path === '/ui/api/access') return json(200, { ...view, templates: view.templates.map((t) => ({ ...t, approvals: t.approvals.filter((a) => a.id !== body?.approval) })) });
    if (path in routes) return json(200, routes[path]);
    return json(404, { error: 'not found' });
  });
  return { fetch, calls };
}

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

let root: Root | undefined;
const matrix = () => document.querySelector('[data-slot="permission-matrix"]');

async function boot(view: AccessView = VIEW) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#settings/permissions';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const daemon = fakeDaemon(view);
  vi.stubGlobal('fetch', daemon.fetch);
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(matrix()?.getAttribute('data-loaded')).toBe('true'));
  return daemon;
}

const button = (label: string, within: ParentNode) => [...within.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
const click = (b: Element | null | undefined) => act(async () => { (b as HTMLElement).click(); });
const cell = (row: string, asset: string) => matrix()!.querySelector(`[data-row="${row}"] [data-asset="${asset}"]`);
const set = (el: HTMLInputElement | HTMLSelectElement, value: string) => act(async () => {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('Settings → Permission matrix', () => {
  it('is a settings section: rows with each template\'s radius, assets grouped by kind, the operations in each cell, the waiting ones apart', async () => {
    await boot();
    expect(document.querySelector('[data-slot="settings-nav"] a[href="#settings/permissions"]')?.textContent).toBe('Permission matrix');
    expect([...matrix()!.querySelectorAll('thead [data-kind]')].map((h) => h.textContent)).toEqual(['cluster', 'aws-account']);
    expect(matrix()!.querySelector('[data-row="template:kubectl-diag"]')!.textContent).toContain('high radius');
    const c = cell('template:kubectl-diag', 'cluster/x')!;
    expect([...c.querySelectorAll('[data-op]')].map((o) => `${o.getAttribute('data-op')}:${o.getAttribute('data-state')}`)).toEqual(['read:approved', 'write:pending']);
    expect(cell('machine:admin/box-kube', 'cluster/x')!.querySelector('[data-op="read"]')).not.toBeNull();
    expect(cell('template:unused', 'cluster/x')!.querySelector('[data-op]')).toBeNull();
  });

  it('a click on a cell says why: the steps to the template, the chain, who approved it and when; Revoke there posts it', async () => {
    const daemon = await boot();
    await click(cell('machine:admin/box-kube', 'cluster/x')!.querySelector('button'));
    const why = document.querySelector('[data-slot="matrix-why"]')!;
    expect(why.textContent).toContain('machine box-kube joined as a box of template kubectl-diag');
    expect(why.textContent).toContain('template kubectl-diag is approved for read on cluster x');
    expect(why.textContent).toContain('read on cluster x grants read on cluster x');
    expect(why.textContent).toContain('approved by alice');
    expect(why.textContent).toContain('write: waits for approval on Settings → Vault');
    await click(button('Revoke', why.querySelector('[data-approval="7"]')!));
    await click(button('Revoke', document.querySelector('[role="alertdialog"]')!));
    await vi.waitFor(() => expect(daemon.calls.find((c) => c.path === '/ui/api/access')?.body).toEqual({ action: 'revoke', approval: 7 }));
    await vi.waitFor(() => expect(cell('template:kubectl-diag', 'cluster/x')!.querySelector('[data-op="read"]')).toBeNull());
  });

  it('switches to the live jobs, and filters', async () => {
    await boot();
    await click(button('Jobs', matrix()!));
    expect([...matrix()!.querySelectorAll('tbody [data-row]')].map((r) => r.getAttribute('data-row'))).toEqual(['job:admin/j-123']);
    await click(button('Templates and machines', matrix()!));
    await set(matrix()!.querySelector<HTMLSelectElement>('select[name="kind"]')!, 'aws-account');
    expect([...matrix()!.querySelectorAll('thead [data-kind]')].map((h) => h.textContent)).toEqual(['aws-account']);
    await set(matrix()!.querySelector<HTMLSelectElement>('select[name="kind"]')!, ALL);
    await act(async () => { matrix()!.querySelector<HTMLInputElement>('input[name="only-with-access"]')!.click(); });
    expect([...matrix()!.querySelectorAll('tbody [data-row]')].map((r) => r.getAttribute('data-row'))).not.toContain('template:unused');
    await set(matrix()!.querySelector<HTMLInputElement>('input[name="search"]')!, 'aws');
    expect([...matrix()!.querySelectorAll('tbody [data-row]')].map((r) => r.getAttribute('data-row'))).toEqual(['template:aws-diag']);
  });

  it('says so when nothing is approved or waiting', async () => {
    await boot({ ...VIEW, templates: [], holders: { machines: [], jobs: [] } });
    expect(matrix()!.querySelector('table')).toBeNull();
    expect(matrix()!.textContent).toMatch(/no asset is approved or waits for approval/i);
  });
});
