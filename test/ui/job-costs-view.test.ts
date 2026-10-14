// @vitest-environment happy-dom
// Job costs on Machines (issue #688), the panel rendered against a fake of GET /api/lanes/costs: the job cost profiles
// grouped by job cost kind first, then by repository or template as the viewer picks, each group with its jobs, the
// mean duration, one lane's share of CPU, memory and disk, and the usage burned. With no profile, it says so.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobCostGroup, JobCosts } from '../../src/domain/types.ts';

const GIB = 1024 ** 3;
const group = (key: string, over: Partial<JobCostGroup> = {}): JobCostGroup => ({
  key, jobs: 2, failed: 0, durationMs: 30 * 60_000, samples: 60, cpu: { avg: 0.2, peak: 0.4 }, memoryBytes: { avg: 2 * GIB, peak: 3 * GIB },
  diskBytes: { avg: GIB, peak: GIB }, usage: { session: 0.05 }, ...over,
});
const COSTS: JobCosts = {
  at: '2026-10-10T12:00:00.000Z', windowDays: 30, jobs: [],
  groups: { kind: [group('code', { jobs: 3, failed: 1 }), group('research')], repo: [group('o/r')], template: [] },
};
const EMPTY: JobCosts = { ...COSTS, groups: { kind: [], repo: [], template: [] } };

let root: Root | undefined;

async function boot(costs = COSTS) {
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (input: string) => json(String(input).split('?')[0] === '/api/lanes/costs' ? costs : {})));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  // Imported by a path in a variable: the UI's modules are typed by the UI's own tsconfig, not this one.
  const store = '../../ui/src/store/index.ts';
  const view = '../../ui/src/views/job-costs.tsx';
  const { useHopper } = (await import(store)) as { useHopper: { setState(s: unknown): void } };
  useHopper.setState({ authed: true, user: { role: 'viewer', realm: 'local', name: 'someone' } });
  const { JobCostsPanel } = (await import(view)) as { JobCostsPanel: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(JobCostsPanel)); });
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const rows = () => [...document.querySelectorAll('[data-slot="job-cost-group"]')].map((r) => r.textContent ?? '');
const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text);

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('job costs on Machines', () => {
  it('groups by job cost kind first: jobs, duration, CPU, memory, disk and usage per group', async () => {
    await boot();
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toContain('code');
    expect(rows()[0]).toContain('3 jobs, 1 failed');
    expect(rows()[0]).toContain('30 min');
    expect(rows()[0]).toContain('20% avg · 40% peak');
    expect(rows()[0]).toContain('2.0 GiB avg · 3.0 GiB peak');
    expect(rows()[0]).toContain('session 5.0%');
  });

  it('the viewer picks the grouping: by repository, by template (none yet)', async () => {
    await boot();
    await act(async () => { button('Repository')!.click(); });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain('o/r');
    await act(async () => { button('Template')!.click(); });
    expect(rows()).toEqual([]);
    expect(document.querySelector('[data-slot="job-costs-empty"]')?.textContent).toMatch(/no job ran on a sandbox box/i);
  });

  it('with no profile, says so', async () => {
    await boot(EMPTY);
    expect(rows()).toEqual([]);
    expect(document.querySelector('[data-slot="job-costs-empty"]')?.textContent).toMatch(/no finished job of the last 30 days/i);
  });
});
