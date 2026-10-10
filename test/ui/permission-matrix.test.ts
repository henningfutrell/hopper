// @vitest-environment happy-dom
// Settings → Permission matrix (issue #559): who may do what on which asset, read from GET /api/access. Rows are the
// templates, each followed by its boxes, then the users — or, switched, the live jobs; the rows besides the templates
// are the requesters (issue #581). Columns are the assets, grouped by kind; each cell the operations approved, and apart
// those of the row's template that wait for approval (issue #584). A click on a cell says why — the relationship path,
// who approved it and when — and revokes from there. Filters: asset kind, operation, a name, and only the rows with
// access. Rendered in happy-dom inside the whole app against a fake daemon.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALL, permissionMatrix, type MatrixFilter } from '../../ui/src/model/permission-matrix.ts';
import type { AccessView, Approval, Asset, Operation } from '../../src/domain/types.ts';

const X: Asset = { kind: 'cluster', name: 'x' };
const ACCOUNT: Asset = { kind: 'aws-account', name: '123456789012' };
const approvalTuple = (template: string, op: Operation, a: Asset) => ({ subject: `template:${template}`, relation: 'approved_for', object: `operation_profile:${op}/${a.kind}/${a.name}` });
const grantTuple = (op: Operation, a: Asset) => ({ subject: `operation_profile:${op}/${a.kind}/${a.name}`, relation: `grants_${op}`, object: `asset:${a.kind}/${a.name}` });
const approval = (id: number, template: string, operation: Operation, asset: Asset): Approval =>
  ({ id, template, profile: { operation, asset }, approvedBy: 'alice', approvedAt: '2026-10-09T11:30:00.000Z', chain: [approvalTuple(template, operation, asset), grantTuple(operation, asset)] });
const owns = { subject: 'user:admin', relation: 'owns', object: 'job:admin/j-123' };
const runsOn = { subject: 'job:admin/j-123', relation: 'runs_on', object: 'machine:admin/box-kube' };
const instance = { subject: 'machine:admin/box-kube', relation: 'instance_of', object: 'template:kubectl-diag' };
const readX = { profile: { operation: 'read' as const, asset: X }, path: [approvalTuple('kubectl-diag', 'read', X), grantTuple('read', X)] };

const VIEW: AccessView = {
  status: { state: 'connected', syncedAt: '2026-10-09T12:00:00.000Z' },
  model: { version: 1, dsl: 'model\n', writtenBy: 'hopper', writtenAt: '2026-10-09T11:00:00.000Z' },
  templates: [
    { template: 'aws-diag', approvals: [approval(9, 'aws-diag', 'read', ACCOUNT)], radius: { level: 'medium', reasons: ['a vault secret'], profiles: [] } },
    { template: 'kubectl-diag', approvals: [approval(7, 'kubectl-diag', 'read', X)], radius: {
      level: 'high', reasons: ['write on cluster x: it changes the asset; waits for an explicit approval'],
      profiles: [{ profile: { operation: 'read', asset: X }, level: 'low', approved: true }, { profile: { operation: 'write', asset: X }, level: 'high', approved: false }],
    } },
    { template: 'unused', approvals: [], radius: { level: 'low', reasons: [], profiles: [] } },
  ],
  revoked: [],
  requesters: [
    { requester: { kind: 'user', userId: 'admin' }, grants: [{ ...readX, path: [owns, runsOn, instance, ...readX.path] }] },
    { requester: { kind: 'job', userId: 'admin', jobId: 'j-123' }, template: 'kubectl-diag', machine: 'box-kube', grants: [{ ...readX, path: [owns, runsOn, instance, ...readX.path] }] },
    { requester: { kind: 'job', userId: 'admin', jobId: 'j-9' }, machine: 'desk', grants: [] },
    { requester: { kind: 'machine', userId: 'admin', machine: 'box-kube' }, template: 'kubectl-diag', grants: [{ ...readX, path: [instance, ...readX.path] }] },
    { requester: { kind: 'user', userId: 'bob' }, grants: [] },
  ],
  decisions: [],
};

const filter = (f: Partial<MatrixFilter> = {}): MatrixFilter => ({ rows: 'requesters', kind: ALL, operation: ALL, search: '', onlyWithAccess: false, ...f });
const ops = (c: ReturnType<ReturnType<typeof permissionMatrix>['cell']>) => [...c.entries.map((e) => e.operation), ...c.pending.map((p) => `${p.operation}?`)];

describe('the permission matrix model', () => {
  it('rows: each template followed by its boxes, then the users; columns: every asset approved or waiting, grouped by kind', () => {
    const m = permissionMatrix(VIEW, filter());
    expect(m.rows.map((r) => r.key)).toEqual(['template:aws-diag', 'template:kubectl-diag', 'machine:admin/box-kube', 'template:unused', 'user:admin', 'user:bob']);
    expect(m.groups.map((g) => [g.kind, g.columns.map((c) => c.asset.name)])).toEqual([['cluster', ['x']], ['aws-account', ['123456789012']]]);
  });

  it('a cell holds what the row may do, each with its path and approval, and apart what its template waits for', () => {
    const m = permissionMatrix(VIEW, filter());
    const x = m.groups[0]!.columns[0]!;
    const row = (key: string) => m.rows.find((r) => r.key === key)!;
    expect(ops(m.cell(row('template:kubectl-diag'), x))).toEqual(['read', 'write?']);
    expect(m.cell(row('template:kubectl-diag'), x).entries[0]!.approval?.id).toBe(7);
    const box = m.cell(row('machine:admin/box-kube'), x);
    expect(ops(box)).toEqual(['read', 'write?']);
    expect(box.entries[0]).toMatchObject({ approval: { id: 7 }, path: [instance, ...readX.path] });
    expect(ops(m.cell(row('user:admin'), x))).toEqual(['read']);
    expect(ops(m.cell(row('user:bob'), x))).toEqual([]);
    expect(ops(m.cell(row('template:aws-diag'), x))).toEqual([]);
  });

  it('the jobs view has one row per live job', () => {
    const m = permissionMatrix(VIEW, filter({ rows: 'jobs' }));
    expect(m.rows.map((r) => [r.key, r.template, r.machine])).toEqual([['job:admin/j-123', 'kubectl-diag', 'box-kube'], ['job:admin/j-9', undefined, 'desk']]);
    expect(ops(m.cell(m.rows[0]!, m.groups[0]!.columns[0]!))).toEqual(['read', 'write?']);
  });

  it('filters by asset kind, operation, name, and only the rows with access', () => {
    expect(permissionMatrix(VIEW, filter({ kind: 'aws-account' })).groups.map((g) => g.kind)).toEqual(['aws-account']);
    const writes = permissionMatrix(VIEW, filter({ operation: 'write' }));
    expect(writes.groups.flatMap((g) => g.columns.map((c) => c.asset.name))).toEqual(['x']);
    expect(ops(writes.cell(writes.rows.find((r) => r.key === 'template:kubectl-diag')!, writes.groups[0]!.columns[0]!))).toEqual(['write?']);
    expect(permissionMatrix(VIEW, filter({ search: 'box' })).rows.map((r) => r.key)).toEqual(['machine:admin/box-kube']);
    expect(permissionMatrix(VIEW, filter({ onlyWithAccess: true })).rows.map((r) => r.key))
      .toEqual(['template:aws-diag', 'template:kubectl-diag', 'machine:admin/box-kube', 'user:admin']);
    expect(permissionMatrix(VIEW, filter({ onlyWithAccess: true, rows: 'jobs' })).rows.map((r) => r.key)).toEqual(['job:admin/j-123']);
    expect(permissionMatrix(VIEW, filter({ onlyWithAccess: true, operation: 'write' })).rows).toEqual([]);
  });
});

interface Call { path: string; method: string; body?: Record<string, unknown> }

/** The daemon: a revoke drops the approval and every grant through it. */
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
    if (path === '/ui/api/access' && body?.approval === 7) {
      return json(200, { ...view, templates: view.templates.map((t) => ({ ...t, approvals: t.approvals.filter((a) => a.id !== 7) })), requesters: view.requesters.map((r) => ({ ...r, grants: [] })) });
    }
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
const rowKeys = () => [...matrix()!.querySelectorAll('tbody [data-row]')].map((r) => r.getAttribute('data-row'));
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
    expect(cell('user:admin', 'cluster/x')!.querySelector('[data-op="read"]')).not.toBeNull();
    expect(cell('user:bob', 'cluster/x')!.querySelector('[data-op]')).toBeNull();
  });

  it('a click on a cell says why: the path, who approved it and when; Revoke there posts it', async () => {
    const daemon = await boot();
    await click(cell('machine:admin/box-kube', 'cluster/x')!.querySelector('button'));
    const why = document.querySelector('[data-slot="matrix-why"]')!;
    expect(why.textContent).toContain('machine box-kube is an instance of template kubectl-diag → template kubectl-diag is approved for read on cluster x → read on cluster x grants read on cluster x');
    expect(why.textContent).toContain('approved by alice');
    expect(why.textContent).toContain('write: waits for approval on Settings → Vault');
    await click(button('Revoke', why.querySelector('[data-approval="7"]')!));
    await click(button('Revoke', document.querySelector('[role="alertdialog"]')!));
    await vi.waitFor(() => expect(daemon.calls.find((c) => c.path === '/ui/api/access')?.body).toEqual({ action: 'revoke', approval: 7 }));
    await vi.waitFor(() => expect(cell('machine:admin/box-kube', 'cluster/x')!.querySelector('[data-op="read"]')).toBeNull());
  });

  it('switches to the live jobs, and filters', async () => {
    await boot();
    await click(button('Jobs', matrix()!));
    expect(rowKeys()).toEqual(['job:admin/j-123', 'job:admin/j-9']);
    expect(matrix()!.querySelector('[data-row="job:admin/j-123"]')!.textContent).toContain('kubectl-diag on box-kube');
    await click(button('Templates, boxes and users', matrix()!));
    await set(matrix()!.querySelector<HTMLSelectElement>('select[name="kind"]')!, 'aws-account');
    expect([...matrix()!.querySelectorAll('thead [data-kind]')].map((h) => h.textContent)).toEqual(['aws-account']);
    await set(matrix()!.querySelector<HTMLSelectElement>('select[name="kind"]')!, ALL);
    await act(async () => { matrix()!.querySelector<HTMLInputElement>('input[name="only-with-access"]')!.click(); });
    expect(rowKeys()).not.toContain('user:bob');
    await set(matrix()!.querySelector<HTMLInputElement>('input[name="search"]')!, 'aws');
    expect(rowKeys()).toEqual(['template:aws-diag']);
  });

  it('says so when nothing is approved or waits', async () => {
    await boot({ ...VIEW, templates: [], requesters: [] });
    expect(matrix()!.querySelector('table')).toBeNull();
    expect(matrix()!.textContent).toMatch(/no asset is approved or waits for approval/i);
  });
});
