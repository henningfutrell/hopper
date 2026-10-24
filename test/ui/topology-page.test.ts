// @vitest-environment happy-dom
// Topology, its own page (ui/src/views/topology-page.tsx, issue #1943), rendered inside the whole app against a fake of the
// daemon's HTTP surface. One click from the sidebar opens it; Infra links to it and holds no second copy. With no source
// it says why and offers its actions in place: add an AWS account or a cluster (the vault's form), and Discover now once
// the vault mints for one. A source whose last read failed shows its error. With sources, it draws the graph, and
// #topology/<node id> picks that node.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { afterReport, joinGraph } from '../../src/domain/topology.ts';
import { awsTopology } from '../../src/domain/topology-discover.ts';
import { aws } from '../support/topology-answers.ts';

type Graph = ReturnType<typeof joinGraph>;
const AT = '2026-10-17T10:00:00.000Z';
const SOURCE = { kind: 'aws', account: '111111111111', region: 'eu-west-1' } as const;
const EMPTY: Graph = { nodes: [], links: [], sources: [] };
const good = (): Graph => joinGraph([afterReport(undefined, { source: SOURCE, ok: true, ...awsTopology(aws) }, 'collector', AT)]);
const failed = (): Graph => joinGraph([
  afterReport(afterReport(undefined, { source: SOURCE, ok: true, ...awsTopology(aws) }, 'collector', AT), { source: SOURCE, ok: false, error: 'AccessDenied on ec2:DescribeVpcs' }, 'collector', '2026-10-17T11:00:00.000Z'),
]);
const MINTING = {
  id: 's1', name: 'AWS_PROD', setBy: 'admin', createdAt: AT, changedBy: 'admin', changedAt: AT, mints: { kind: 'aws-account', name: '111111111111' },
};

function fakeDaemon(topology: Graph, secrets: unknown[] = []) {
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [], locked: [] },
    '/api/machines': { machines: [] }, '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] }, '/api/questions': { questions: [] },
    '/api/sources': { sources: [] }, '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
    '/api/topology': topology,
    '/api/vault': { secrets, templates: [], backends: [], shared: [], sandboxApprovals: { template: false, sandbox: false } },
    '/api/infra-plans': { plans: [], applies: [], settings: { autoApprove: false }, watchers: {} },
    '/api/out-of-band': { changes: [], controllers: [] },
  };
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string) => {
    const path = String(input).split('?')[0]!;
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'admin', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (path in routes) return json(200, routes[path]);
    return json(404, { error: 'not found' });
  });
}

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

let root: Root | undefined;

async function boot(hash: string, topology: Graph, secrets: unknown[] = []) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = hash;
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', fakeDaemon(topology, secrets));
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
}

const page = (): Element => document.querySelector('[data-slot="topology-page"]')!;
const button = (scope: Element, words: string): HTMLButtonElement | undefined =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent?.includes(words)) as HTMLButtonElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('the Topology page', () => {
  it('is one click from the sidebar, in the Infra group; Infra links to it and draws no second copy', async () => {
    await boot('#infra', good());
    const link = await vi.waitFor(() => { const a = document.querySelector('aside [data-nav-group="infra"] a[href="#topology"]'); expect(a).not.toBeNull(); return a!; });
    expect(link.textContent).toBe('Topology');
    await vi.waitFor(() => expect(document.body.textContent).toContain('No plans yet'));
    expect(document.querySelector('[data-slot="topology-graph"]')).toBeNull();
    expect(document.querySelector('[data-slot="infra-topology-link"] a[href="#topology"]')).not.toBeNull();
  });

  it('with no source, says why and offers to add an AWS account or a cluster in place; no Discover now until the vault mints for one', async () => {
    await boot('#topology', EMPTY);
    const empty = await vi.waitFor(() => { const e = page()?.querySelector('[data-slot="topology-empty"]'); expect(e?.textContent).toContain('The vault mints for no AWS account and no Kubernetes cluster'); return e!; });
    expect(empty.textContent).toContain('no read-only check reported a source');
    expect(page().querySelector('[data-slot="topology-discover"]')).toBeNull();
    expect(button(empty, 'Add a cluster')).toBeDefined();
    await act(async () => button(empty, 'Add an AWS account')!.click());
    const mints = page().querySelector('input[placeholder="cluster/lab, aws-account/123456789012 or database/lab/apps/orders"]') as HTMLInputElement;
    expect(mints.value).toBe('aws-account/');
    expect(button(page(), 'Set secret')).toBeDefined();
  });

  it('with no source but a minting credential, says the read is still to come and offers Discover now', async () => {
    await boot('#topology', EMPTY, [MINTING]);
    const empty = await vi.waitFor(() => { const e = page()?.querySelector('[data-slot="topology-empty"]'); expect(e?.textContent).toContain('aws-account/111111111111'); return e!; });
    expect(empty.textContent).toContain('no read reported yet');
    expect(button(page().querySelector('[data-slot="topology-discover"]')!, 'Discover now')).toBeDefined();
  });

  it('shows each source\'s last read error', async () => {
    await boot('#topology', failed(), [MINTING]);
    const errors = await vi.waitFor(() => { const e = page()?.querySelector('[data-slot="topology-read-errors"]'); expect(e).not.toBeNull(); return e!; });
    expect(errors.textContent).toContain('AWS 111111111111 eu-west-1');
    expect(errors.textContent).toContain('AccessDenied on ec2:DescribeVpcs');
    expect(page().querySelector('[data-slot="topology-graph"]')).not.toBeNull();
  });

  it('with sources, draws the graph with no error box, and #topology/<node id> picks that node', async () => {
    const db = 'arn:aws:rds:eu-west-1:111111111111:db:orders';
    await boot(`#topology/${encodeURIComponent(db)}`, good(), [MINTING]);
    await vi.waitFor(() => expect(page()?.querySelector('[data-slot="topology-graph"]')).toBeTruthy());
    expect(page().querySelector('[data-slot="topology-read-errors"]')).toBeNull();
    expect(page().querySelector('[data-slot="topology-empty"]')).toBeNull();
    expect(page().querySelector('[data-slot="topology-node"]')?.textContent).toContain(db);
  });
});
