// @vitest-environment happy-dom
// Settings → Access (issue #559), rendered in happy-dom inside the whole app against a fake of the daemon's HTTP
// surface: whether OpenFGA can be asked, and why not; each template's approvals with the relationship chain from the
// template to the asset, each with Revoke (asked once, then POST /ui/api/access); a check tried for a template, an
// operation and an asset, with its answer and path; the newest decisions; and the model, saved against its version.
// Issue #581: each requester — a user, a live job, a box — is a row of the permission matrix, each asset a column, each
// cell the operations it may do, with the path.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chainText, tupleText } from '../../ui/src/model/access.ts';

const read = { subject: 'template:kubectl-diag', relation: 'approved_for', object: 'operation_profile:read/cluster/x' };
const grant = { subject: 'operation_profile:read/cluster/x', relation: 'grants_read', object: 'asset:cluster/x' };
const running = { subject: 'job:trial/t1', relation: 'running', object: 'template:kubectl-diag' };
const owns = { subject: 'user:admin', relation: 'owns', object: 'job:admin/j1' };
const runsOn = { subject: 'job:admin/j1', relation: 'runs_on', object: 'machine:admin/kbox' };
const instance = { subject: 'machine:admin/kbox', relation: 'instance_of', object: 'template:kubectl-diag' };
const READ_X = { operation: 'read', asset: { kind: 'cluster', name: 'x' } };
const VIEW = {
  status: { state: 'connected', syncedAt: '2026-10-09T12:00:00.000Z', storeId: 's1', modelId: 'm1' },
  model: { version: 3, dsl: 'model\n  schema 1.1\n', writtenBy: 'hopper', writtenAt: '2026-10-09T11:00:00.000Z' },
  templates: [{ template: 'kubectl-diag', approvals: [{ id: 7, template: 'kubectl-diag', profile: { operation: 'read', asset: { kind: 'cluster', name: 'x' } }, approvedBy: 'alice', approvedAt: '2026-10-09T11:30:00.000Z', chain: [read, grant] }], radius: {
    level: 'high', reasons: ['write on cluster x: it changes the asset; waits for an explicit approval'],
    profiles: [{ profile: { operation: 'read', asset: { kind: 'cluster', name: 'x' } }, level: 'low', approved: true }, { profile: { operation: 'write', asset: { kind: 'cluster', name: 'x' } }, level: 'high', approved: false }],
  } }],
  revoked: [],
  requesters: [
    { requester: { kind: 'user', userId: 'admin' }, grants: [{ profile: READ_X, path: [owns, runsOn, instance, read, grant] }] },
    { requester: { kind: 'job', userId: 'admin', jobId: 'j1' }, template: 'kubectl-diag', machine: 'kbox', grants: [{ profile: READ_X, path: [owns, runsOn, instance, read, grant] }] },
    { requester: { kind: 'machine', userId: 'admin', machine: 'kbox' }, template: 'kubectl-diag', grants: [{ profile: READ_X, path: [instance, read, grant] }] },
    { requester: { kind: 'user', userId: 'bob' }, grants: [] },
  ],
  decisions: [
    { id: 'd2', at: '2026-10-09T12:01:00.000Z', allowed: false, reason: 'template kubectl-diag is not approved to write on cluster x', template: 'kubectl-diag', operation: 'write', asset: { kind: 'cluster', name: 'x' }, requester: { kind: 'job', userId: 'admin', jobId: 'j1' } },
    { id: 'd1', at: '2026-10-09T12:00:30.000Z', allowed: true, reason: 'template kubectl-diag is approved to read on cluster x', template: 'kubectl-diag', operation: 'read', asset: { kind: 'cluster', name: 'x' }, trial: { by: 'alice' }, path: [running, read, grant] },
  ],
};

interface Call { path: string; method: string; body?: Record<string, unknown> }

function fakeDaemon(view: unknown) {
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
    if (path === '/ui/api/access' && body?.action === 'check') {
      return json(200, { id: 'd3', at: '2026-10-09T12:02:00.000Z', allowed: true, reason: 'template kubectl-diag is approved to read on cluster x', template: 'kubectl-diag', operation: 'read', asset: { kind: 'cluster', name: 'x' }, trial: { by: 'alice' }, path: [running, read, grant] });
    }
    if (path === '/ui/api/access') return json(200, view);
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

async function boot(view: unknown = VIEW) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#settings/access';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const daemon = fakeDaemon(view);
  vi.stubGlobal('fetch', daemon.fetch);
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(panel()?.querySelector('[data-access-state]')).not.toBeNull());
  return daemon;
}

const panel = () => document.querySelector('[data-slot="access"]');
const button = (label: string, within: ParentNode = panel()!) => [...within.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
const click = (b: HTMLElement | undefined) => act(async () => { b!.click(); });
const set = (el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) => act(async () => {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('access model', () => {
  it('reads a tuple and a chain in plain words', () => {
    expect(tupleText(read)).toBe('template kubectl-diag is approved for read on cluster x');
    expect(tupleText(grant)).toBe('read on cluster x grants read on cluster x');
    expect(tupleText(running)).toBe('this job runs from template kubectl-diag');
    expect(tupleText({ subject: 'a:b', relation: 'odd', object: 'c:d' })).toBe('a:b odd c:d');
    expect(chainText([running, read, grant])).toBe('this job runs from template kubectl-diag → template kubectl-diag is approved for read on cluster x → read on cluster x grants read on cluster x');
  });

  it('reads the requester relations in plain words (issue #581)', () => {
    expect(tupleText(owns)).toBe('user admin owns job j1');
    expect(tupleText(runsOn)).toBe('job j1 runs on machine kbox');
    expect(tupleText(instance)).toBe('machine kbox is an instance of template kubectl-diag');
    expect(tupleText({ subject: 'machine:admin/my%20box', relation: 'instance_of', object: 'template:t' })).toBe('machine my box is an instance of template t');
  });
});

describe('Settings → Access', () => {
  it('shows OpenFGA connected, each template\'s approvals with the chain, and the newest decisions', async () => {
    await boot();
    expect(document.querySelector('[data-slot="settings-nav"] a[href="#settings/access"]')?.textContent).toBe('Access');
    expect(panel()!.querySelector('[data-access-state]')!.getAttribute('data-access-state')).toBe('connected');
    const approval = panel()!.querySelector('[data-approval="7"]')!;
    expect(approval.textContent).toContain('read on cluster x');
    expect(approval.textContent).toContain('alice');
    expect(approval.textContent).toContain('template kubectl-diag is approved for read on cluster x');
    const decisions = [...panel()!.querySelectorAll('[data-decision]')];
    expect(decisions.map((d) => d.getAttribute('data-allowed'))).toEqual(['false', 'true']);
    expect(decisions[0]!.textContent).toContain('not approved to write on cluster x');
    expect(decisions[1]!.textContent).toContain('this job runs from template kubectl-diag');
  });

  it('shows each requester as a row of the permission matrix: each asset a column, each cell what it may do, with the path (issue #581)', async () => {
    await boot();
    const matrix = panel()!.querySelector('[data-slot="access-matrix"]')!;
    expect([...matrix.querySelectorAll('th[data-asset]')].map((h) => h.textContent)).toEqual(['cluster x']);
    const rows = [...matrix.querySelectorAll('[data-requester]')];
    expect(rows.map((r) => r.getAttribute('data-requester'))).toEqual(['user:admin', 'job:admin/j1', 'machine:admin/kbox', 'user:bob']);
    expect(rows[1]!.textContent).toContain('job j1');
    expect(rows[1]!.textContent).toContain('on kbox, template kubectl-diag');
    const cell = rows[1]!.querySelector('[data-cell="cluster/x"]')!;
    expect(cell.textContent).toBe('read');
    expect(cell.getAttribute('title')).toBe('user admin owns job j1 → job j1 runs on machine kbox → machine kbox is an instance of template kubectl-diag → template kubectl-diag is approved for read on cluster x → read on cluster x grants read on cluster x');
    expect(rows[3]!.querySelector('[data-cell="cluster/x"]')!.textContent).toBe('—');
    expect(panel()!.querySelector('[data-decision="d2"]')!.textContent).toContain('job j1');
  });

  it('shows each template\'s blast radius and its reasons next to it, and what waits for approval (issue #584)', async () => {
    await boot();
    const t = panel()!.querySelector('[data-template="kubectl-diag"]')!;
    expect(t.textContent).toContain('high radius');
    expect(t.querySelector('[data-slot="template-radius"]')!.textContent).toBe('write on cluster x: it changes the asset; waits for an explicit approval');
    expect(t.textContent).toContain('Waits for approval on Settings → Vault: write on cluster x');
  });

  it('says why OpenFGA cannot be asked, and that every credential is denied meanwhile', async () => {
    await boot({ ...VIEW, status: { state: 'unreachable', why: 'connect ECONNREFUSED openfga:8080' } });
    const state = panel()!.querySelector('[data-access-state]')!;
    expect(state.getAttribute('data-access-state')).toBe('unreachable');
    expect(state.textContent).toContain('connect ECONNREFUSED openfga:8080');
    expect(state.textContent).toMatch(/every credential is denied/i);
  });

  it('Revoke asks once, then posts the approval', async () => {
    const daemon = await boot();
    await click(button('Revoke', panel()!.querySelector('[data-approval="7"]')!));
    await click(button('Revoke', document.querySelector('[role="alertdialog"]')!));
    await vi.waitFor(() => expect(daemon.calls.find((c) => c.path === '/ui/api/access')?.body).toEqual({ action: 'revoke', approval: 7 }));
  });

  it('Check asks for a template, an operation and an asset, and shows the answer with its path', async () => {
    const daemon = await boot();
    const form = panel()!.querySelector('[data-slot="access-check"]')!;
    await set(form.querySelector<HTMLInputElement>('input[name="template"]')!, 'kubectl-diag');
    await set(form.querySelector<HTMLSelectElement>('select[name="operation"]')!, 'read');
    await set(form.querySelector<HTMLSelectElement>('select[name="kind"]')!, 'cluster');
    await set(form.querySelector<HTMLInputElement>('input[name="asset"]')!, 'x');
    await click(button('Check', form));
    await vi.waitFor(() => expect(form.querySelector('[data-check-result]')?.getAttribute('data-check-result')).toBe('allowed'));
    expect(daemon.calls.find((c) => c.path === '/ui/api/access')?.body).toEqual({ action: 'check', template: 'kubectl-diag', operation: 'read', asset: { kind: 'cluster', name: 'x' } });
    expect(form.textContent).toContain('template kubectl-diag is approved for read on cluster x');
  });

  it('Save model posts the model with the version it was read at', async () => {
    const daemon = await boot();
    const box = panel()!.querySelector<HTMLTextAreaElement>('textarea[name="access-model"]')!;
    expect(box.value).toBe('model\n  schema 1.1\n');
    await set(box, 'model\n  schema 1.1\n# edited\n');
    await click(button('Save model'));
    await vi.waitFor(() => expect(daemon.calls.find((c) => c.path === '/ui/api/access')?.body).toEqual({ action: 'model', dsl: 'model\n  schema 1.1\n# edited\n', version: 3 }));
  });
});
