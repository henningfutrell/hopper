// @vitest-environment happy-dom
// The Resources page (issue #947), rendered against a fake of the daemon's HTTP: one row per container of the stack and
// per sandbox box, labelled by its service — CPU, memory against its limit, network, disk, restarts and uptime —, and
// the hopper's Postgres: connections against the most it allows, size, cache hits, locks, long transactions and
// statement latency. What cannot be read says why.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StackHistory, StackResources } from '../../src/domain/types.ts';

type El = ReturnType<typeof createElement>;
let root: Root | undefined;
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const NOW = Date.parse('2026-10-12T12:00:00.000Z');

const READ: StackResources = {
  at: '2026-10-12T12:00:00.000Z',
  containers: {
    containers: [
      {
        service: 'postgres', group: 'stack', name: 'hopper-postgres-1', image: 'postgres:17-alpine', state: 'running', health: 'healthy',
        startedAt: '2026-10-12T09:00:00.000Z', restarts: 2, cpuCores: 0.25, cpuLimitCores: 2, memUsedBytes: 512 * MiB, memLimitBytes: 2 * GiB,
        netRxBytes: 3 * MiB, netTxBytes: 1536, diskReadBytes: 10 * MiB, diskWriteBytes: 20 * MiB, layerBytes: 4096, volumes: [{ name: 'hopper_postgres', bytes: 50 * MiB }],
      },
      { service: 'kms', group: 'stack', name: 'hopper-kms-1', image: 'local-kms', state: 'exited', restarts: 0 },
      { service: 'hopper-sandbox-claude', group: 'sandbox', name: 'hopper-sandbox-claude', image: 'box:1', state: 'running', startedAt: '2026-10-12T11:30:00.000Z', restarts: 0, memUsedBytes: 100 * MiB },
    ],
  },
  postgres: {
    connections: { active: 3, total: 12, max: 100 }, databaseBytes: 80 * MiB, cacheHitFrac: 0.987, locksWaiting: 1, longTransactions: 0,
    oldestTransactionS: 4, statements: { calls: 1200, meanMs: 0.42 },
  },
  openfga: { checks: 400, errors: 6, meanMs: 1.25 },
};

const at = (m: number) => new Date(NOW - m * 60_000).toISOString();
const HISTORY: StackHistory = {
  view: { range: { preset: '24h' } }, from: at(24 * 60), to: at(0), stepMs: 15 * 60_000, retentionDays: 30,
  series: [
    { service: 'postgres', group: 'stack', metric: 'cpu', points: [{ at: at(30), usedFrac: 0.1 }, { at: at(15), usedFrac: 0.2 }], gaps: [] },
    { service: 'postgres', group: 'stack', metric: 'connections', points: [{ at: at(30), usedFrac: 0.12 }], gaps: [] },
    { service: 'openfga', group: 'stack', metric: 'check-errors', points: [{ at: at(30), usedFrac: 0.01 }], gaps: [] },
    { service: 'hopper-sandbox-claude', group: 'sandbox', metric: 'cpu', points: [{ at: at(30), usedFrac: 0.5 }], gaps: [] },
  ],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function render(read: StackResources | { status: number; error: string } = READ) {
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ('status' in read ? json({ error: read.error }, read.status)
    : String(url).startsWith('/api/resources/history') ? json(HISTORY) : json(read))));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  const store = '../../ui/src/store/index.ts';
  const { useHopper } = (await import(store)) as { useHopper: { setState(s: Record<string, unknown>): void } };
  useHopper.setState({ authed: true, serverOffsetMs: 0, user: { id: 'u1', name: 'ada', role: 'admin', realm: 'github', identity: 'ada', instanceAdmin: true } });
  const view = '../../ui/src/views/resources.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { Resources } = (await import(view)) as { Resources: () => El };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(Resources)); });
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const rows = () => [...document.querySelectorAll('[data-slot="container-row"]')].map((r) => r.textContent ?? '');
const postgres = () => document.querySelector('[data-slot="postgres-reading"]')?.textContent ?? '';
const openfga = () => document.querySelector('[data-slot="openfga-reading"]')?.textContent ?? '';
const legend = () => [...document.querySelectorAll('[data-slot="usage-graph-legend"] button')].map((b) => [b.textContent ?? '', b.getAttribute('aria-pressed')]);

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

describe('the Resources page', () => {
  it('shows each container by its service: CPU, memory against its limit, network, disk, restarts and uptime', async () => {
    await render();
    const [pg, kms, box] = rows();
    expect(pg).toContain('postgres');
    expect(pg).toContain('healthy');
    expect(pg).toContain('0.25 of 2 cores');
    expect(pg).toContain('512 MiB of 2 GiB (25%)');
    expect(pg).toContain('in 3 MiB, out 1.5 KiB');
    expect(pg).toContain('hopper_postgres 50 MiB');
    expect(pg).toContain('2 restarts');
    expect(pg).toContain('up 3h 0m');
    expect(kms).toContain('kms');
    expect(kms).toContain('exited');
    expect(box).toContain('hopper-sandbox-claude');
    expect(box).toContain('100 MiB, no limit');
    expect(document.body.textContent).toContain('Sandbox boxes');
  });

  it('shows Postgres: connections against its maximum, size, cache hits, locks, transactions and statement latency', async () => {
    await render();
    const text = postgres();
    expect(text).toContain('12 of 100 connections, 3 active');
    expect(text).toContain('80 MiB');
    expect(text).toContain('98.7%');
    expect(text).toContain('1 lock waiting');
    expect(text).toContain('no long transactions');
    expect(text).toContain('0.42 ms mean over 1200 statements');
  });

  it('shows OpenFGA: the mean check time and the share of checks that failed', async () => {
    await render();
    const text = openfga();
    expect(text).toContain('1.25 ms mean over 400 checks');
    expect(text).toContain('6 of 400 checks failed (1.5%)');
  });

  it('OpenFGA before any check says so', async () => {
    await render({ ...READ, openfga: { checks: 0, errors: 0 } });
    expect(openfga()).toContain('no checks yet');
  });

  it('says why the containers, the statement latency or OpenFGA cannot be read', async () => {
    await render({ ...READ, containers: { problem: 'the hopper is given no container runtime socket' }, postgres: { ...READ.postgres, statements: { problem: 'pg_stat_statements is not installed' } } as StackResources['postgres'], openfga: { problem: 'the hopper is given no OpenFGA' } });
    expect(document.body.textContent).toContain('the hopper is given no container runtime socket');
    expect(postgres()).toContain('pg_stat_statements is not installed');
    expect(document.body.textContent).toContain('the hopper is given no OpenFGA');
  });

  it('shows the stack over time: a line per service and metric; a sandbox box\'s hidden at first', async () => {
    await render();
    expect(document.body.textContent).toContain('Stack resources over time');
    expect(legend()).toEqual([
      ['postgres · CPU', 'true'], ['postgres · connections', 'true'], ['openfga · failed checks', 'true'], ['hopper-sandbox-claude · CPU', 'false'],
    ]);
  });

  it('a read the daemon refuses says why', async () => {
    await render({ status: 403, error: 'only the hopper\'s admin may do this' });
    expect(document.body.textContent).toContain('only the hopper\'s admin may do this');
  });
});
