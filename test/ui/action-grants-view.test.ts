// @vitest-environment happy-dom
// Access requests, "AWS actions" (issue #2206), rendered in happy-dom inside the whole app against a fake of the daemon's
// HTTP surface: a job's need step that needs an AWS action no role it may use allows is a card — the job, why, the role,
// the action and the resource —, with Grant and Decline; Grant posts exactly that scope. A grant says who granted it and
// when it ends, and Revoke takes it back. The Access requests badge counts the ask.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const JOB = 'de987f4a-0000-4000-8000-000000000001';
const SCOPE = { role: '167028478405/hopper-action', action: 'eks:UpdateNodegroupConfig', resource: 'arn:aws:eks:us-west-1:167028478405:nodegroup/identity-eks/identity-eks-nodes/*' };
const ASK = { job: JOB, ...SCOPE, at: '2026-10-19T12:00:00.000Z', why: 'Scale the node group to 6 nodes', jobTitle: 'Scale the identity nodes' };
const GRANT = { role: '167028478405/hopper-action', action: 's3:PutObject', resource: 'arn:aws:s3:::bucket/key', by: 'alice', at: '2026-10-19T11:00:00.000Z', expiresAt: '2026-10-26T11:00:00.000Z' };
const VIEW = { secrets: [], templates: [], actionAsks: [ASK], actionGrants: [GRANT] };

interface Call { path: string; method: string; body?: Record<string, unknown> }

function fakeDaemon() {
  const calls: Call[] = [];
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
    if (path === '/ui/api/sandbox-requests') return json(200, { ...VIEW, actionAsks: [], actionGrants: [GRANT, { ...SCOPE, by: 'alice', at: '2026-10-19T12:01:00.000Z' }] });
    if (path === '/ui/api/sandbox-approvals') return json(200, { ...VIEW, actionGrants: [] });
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

async function boot() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#access-requests';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const daemon = fakeDaemon();
  vi.stubGlobal('fetch', daemon.fetch);
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(card()).not.toBeNull());
  return daemon;
}

const card = (): HTMLElement | null => [...document.querySelectorAll('[data-action-ask]')].at(0) as HTMLElement | undefined ?? null;
const grantRow = (): HTMLElement | null => [...document.querySelectorAll('[data-action-grant]')].find((l) => l.textContent?.includes('s3:PutObject')) as HTMLElement | undefined ?? null;
const button = (in_: HTMLElement, text: string): HTMLButtonElement => [...in_.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)! as HTMLButtonElement;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('Access requests: a job\'s step that needs an AWS action (issue #2206)', () => {
  it('shows the job, why, the role, the exact action and the resource; Grant posts that scope', async () => {
    const daemon = await boot();
    const c = card()!;
    expect(c.textContent).toContain('Scale the identity nodes');
    expect(c.textContent).toContain('Scale the node group to 6 nodes');
    expect(c.textContent).toContain('eks:UpdateNodegroupConfig');
    expect(c.textContent).toContain(SCOPE.resource);
    expect(c.textContent).toContain('aws-role 167028478405/hopper-action');
    await act(async () => { button(c, 'Grant').click(); });
    await vi.waitFor(() => expect(daemon.calls.find((x) => x.path === '/ui/api/sandbox-requests')).toMatchObject({ method: 'POST', body: { action: 'grant-action', job: JOB, grant: SCOPE } }));
    await vi.waitFor(() => expect(card()).toBeNull());
  });

  it('Decline posts the decline of that ask', async () => {
    const daemon = await boot();
    await act(async () => { button(card()!, 'Decline').click(); });
    await vi.waitFor(() => expect(daemon.calls.find((x) => x.path === '/ui/api/sandbox-requests')).toMatchObject({ body: { action: 'decline-action', job: JOB, grant: SCOPE } }));
  });

  it('a grant says who granted it and when it ends; Revoke takes it back', async () => {
    const daemon = await boot();
    const row = grantRow()!;
    expect(row.textContent).toContain('granted by alice');
    expect(row.textContent).toContain('2026-10-26');
    await act(async () => { button(row, 'Revoke').click(); });
    await vi.waitFor(() => expect(daemon.calls.find((x) => x.path === '/ui/api/sandbox-approvals')).toMatchObject({ body: { revokeAction: { role: GRANT.role, action: GRANT.action, resource: GRANT.resource } } }));
    await vi.waitFor(() => expect(grantRow()).toBeNull());
  });
});
