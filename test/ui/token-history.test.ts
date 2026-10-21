// @vitest-environment happy-dom
// Issue #2302, part 2: the Dashboard's tokens over time, beside the usage graph — the token ledger by day, stacked by
// repository or account (GET /api/usage/tokens?by=day&split=…). Each day's stacks sum to the day, and the days to the
// ledger's total, which the panel shows. Counts only.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TokenRollupRow } from '../../src/domain/token-usage.ts';

// Browser code, type-checked by ui/tsconfig.json: imported by path.
const MODEL = '../../ui/src/model/token-ledger.ts';
const LAYOUT = '../../ui/src/model/dashboard-layout.ts';
const VIEW = '../../ui/src/views/dashboard/token-history.tsx';

interface TokenDay { day: string; tokens: number; costUsd: number; parts: { key: string; tokens: number; costUsd: number }[] }
interface Model {
  tokensOf(t: { input: number; output: number; cacheRead: number; cacheWrite: number }): number;
  tokenDays(groups: TokenRollupRow[], days: number, today: string, most?: number): { days: TokenDay[]; stacks: { key: string; color: string }[] };
}

const totals = (input: number, costUsd = input / 1000) => ({ turns: 1, input, output: 0, cacheRead: 0, cacheWrite: 0, costUsd, costKnown: true });
const part = (key: string, input: number): TokenRollupRow => ({ key, jobs: 1, ...totals(input) });
const day = (key: string, parts: TokenRollupRow[]): TokenRollupRow =>
  ({ key, jobs: parts.length, ...totals(parts.reduce((n, p) => n + p.input, 0)), parts });

const GROUPS = [
  day('2026-10-21', [part('o/a', 400), part('o/b', 100)]),
  day('2026-10-19', [part('o/a', 50), part('o/c', 25)]),
];

describe('tokens over time, by day (issue #2302)', () => {
  it('counts every token of a row: input, output, cache read and cache write', async () => {
    const { tokensOf } = (await import(MODEL)) as Model;
    expect(tokensOf({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })).toBe(10);
  });

  it('gives every day of the range, an empty one too, each split as the ledger split it', async () => {
    const { tokenDays } = (await import(MODEL)) as Model;
    const { days, stacks } = tokenDays(GROUPS, 4, '2026-10-21');
    expect(days.map((d) => [d.day, d.tokens])).toEqual([['2026-10-18', 0], ['2026-10-19', 75], ['2026-10-20', 0], ['2026-10-21', 500]]);
    // The biggest stack first.
    expect(stacks.map((s) => s.key)).toEqual(['o/a', 'o/b', 'o/c']);
    for (const d of days) expect(d.parts.reduce((n, p) => n + p.tokens, 0)).toBe(d.tokens);
  });

  it('sums the stacks past the biggest few as other, so the days still reconcile', async () => {
    const { tokenDays } = (await import(MODEL)) as Model;
    const { days, stacks } = tokenDays(GROUPS, 3, '2026-10-21', 1);
    expect(stacks.map((s) => s.key)).toEqual(['o/a', 'other']);
    expect(days.at(-1)!.parts).toEqual([{ key: 'o/a', tokens: 400, costUsd: 0.4 }, { key: 'other', tokens: 100, costUsd: 0.1 }]);
    expect(days.reduce((n, d) => n + d.tokens, 0)).toBe(575);
  });

  it('is a dashboard panel beside the usage graph, split by repository unless the viewer chose account', async () => {
    const { DEFAULT_LAYOUT, parseLayout } = (await import(LAYOUT)) as {
      DEFAULT_LAYOUT: { panels: { id: string }[]; settings: { tokenSplit: string } };
      parseLayout(text: string | null): { settings: { tokenSplit: string } };
    };
    const ids = DEFAULT_LAYOUT.panels.map((p) => p.id);
    expect(ids.indexOf('tokenHistory')).toBe(ids.indexOf('usageHistory') + 1);
    expect(DEFAULT_LAYOUT.settings.tokenSplit).toBe('repo');
    expect(parseLayout(JSON.stringify({ settings: { tokenSplit: 'account' } })).settings.tokenSplit).toBe('account');
    expect(parseLayout(JSON.stringify({ settings: { tokenSplit: 'colour' } })).settings.tokenSplit).toBe('repo');
  });
});

let root: Root | undefined;
const reads: string[] = [];

async function render(split: 'repo' | 'account') {
  reads.length = 0;
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    reads.push(String(input));
    const by = new URL(String(input), 'http://x').searchParams.get('split');
    const groups = by === 'account' ? [day('2026-10-21', [part('work', 300), part('personal', 200)])] : GROUPS;
    return json({ by: 'day', total: totals(groups.reduce((n, g) => n + g.input, 0)), groups, top: [] });
  }));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  const { useHopper } = (await import('../../ui/src/store/index.ts' as string)) as { useHopper: { setState(s: unknown): void } };
  useHopper.setState({ authed: true, user: { role: 'viewer', realm: 'local', name: 'someone' } });
  const { TokenHistoryPanel } = (await import(VIEW)) as { TokenHistoryPanel: (p: { split: string; onSplit: (s: string) => void }) => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(TokenHistoryPanel, { split, onSplit: () => {} })); });
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const slots = (slot: string) => [...document.querySelectorAll(`[data-slot="${slot}"]`)].map((e) => e.textContent ?? '');

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('the Tokens over time panel (issue #2302)', () => {
  it('reads the ledger by day split by repository, and shows its total and a legend entry per repository', async () => {
    await render('repo');
    expect(reads.some((r) => r.startsWith('/api/usage/tokens?') && r.includes('by=day') && r.includes('split=repo') && r.includes('since='))).toBe(true);
    expect(slots('token-history-total')[0]).toContain('575');
    expect(slots('token-history-stack')).toEqual(['o/a', 'o/b', 'o/c']);
  });

  it('stacks by account when the viewer chose it', async () => {
    await render('account');
    expect(reads.some((r) => r.includes('split=account'))).toBe(true);
    expect(slots('token-history-stack')).toEqual(['work', 'personal']);
  });
});
