// @vitest-environment happy-dom
// Issue #1182: the Dashboard's Usage over time stayed on "reading the usage history…" without end when its read got
// no answer. A read now fails after its time; the card says so with a Retry, keeps the last graph, and a stream tick
// while a read is out reads again once after it, not once per tick. Rendered in happy-dom against the store.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

type El = ReturnType<typeof createElement>;
const store = '../../ui/src/store/index.ts';
const card = '../../ui/src/components/usage-graph-card.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
const api = '../../ui/src/lib/api.ts';
interface Store { useHopper: { setState(s: Record<string, unknown>): void } }

const HISTORY = {
  view: { range: { preset: '24h' } }, from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date().toISOString(),
  stepMs: 3_600_000, series: [],
};
const EMPTY = 'No usage history in this range yet.';
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** A daemon whose reads hang until told to answer; a hanging read ends only when its signal aborts, as fetch's does. */
function daemon() {
  const pending: { resolve: (r: Response) => void }[] = [];
  let answering = false;
  const fetch = vi.fn((_input: string, init?: RequestInit) => {
    if (answering) return Promise.resolve(json(HISTORY));
    return new Promise<Response>((resolve, reject) => {
      pending.push({ resolve });
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  });
  return { fetch, answer: () => { answering = true; for (const p of pending.splice(0)) p.resolve(json(HISTORY)); } };
}

let root: Root | undefined;

async function render(fetch: ReturnType<typeof daemon>['fetch']) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  vi.stubGlobal('fetch', fetch);
  const { useHopper } = (await import(store)) as Store;
  useHopper.setState({ authed: true, recorded: { usage: 0, machine: 0 } });
  const { UsageGraphCard } = (await import(card)) as { UsageGraphCard: (p: Record<string, unknown>) => El };
  await act(async () => {
    root = createRoot(document.getElementById('root')!);
    root.render(createElement(UsageGraphCard, { path: '/api/usage/history', seriesOf: (h: typeof HISTORY) => h.series, title: 'Usage over time', empty: EMPTY }));
  });
  return useHopper;
}

const text = () => document.getElementById('root')!.textContent ?? '';
const retry = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Retry');

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a usage graph read that gets no answer (issue #1182)', () => {
  it('a read that hangs fails after its time', async () => {
    vi.useFakeTimers();
    const d = daemon();
    vi.stubGlobal('fetch', d.fetch);
    const { get, READ_TIMEOUT_MS, ReadTimedOut } = (await import(api)) as { get(path: string): Promise<unknown>; READ_TIMEOUT_MS: number; ReadTimedOut: new () => Error };
    const read = get('/api/usage/history');
    const failed = expect(read).rejects.toBeInstanceOf(ReadTimedOut);
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
    await failed;
  });

  it('a hanging read ends in the error state with a Retry, not in "reading…" without end', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d = daemon();
    await render(d.fetch);
    expect(text()).toContain('reading the usage history…');
    const { READ_TIMEOUT_MS } = (await import(api)) as { READ_TIMEOUT_MS: number };
    await act(async () => { await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS); });
    expect(text()).not.toContain('reading the usage history…');
    expect(text()).toContain('usage history unavailable: no answer in 15 s');
    expect(retry()).toBeDefined();

    // Retry reads again; the daemon answers now.
    d.answer();
    await act(async () => { retry()!.click(); });
    await vi.waitFor(() => expect(text()).toContain(EMPTY));
    expect(text()).not.toContain('unavailable');
  });

  it('keeps the last graph when a later read fails', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let hang = false;
    const fetch = vi.fn((_input: string, init?: RequestInit) => hang
      ? new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
      : Promise.resolve(json(HISTORY)));
    const useHopper = await render(fetch);
    await vi.waitFor(() => expect(text()).toContain(EMPTY));
    hang = true;
    await act(async () => { useHopper.setState({ recorded: { usage: 1, machine: 0 } }); });
    const { READ_TIMEOUT_MS } = (await import(api)) as { READ_TIMEOUT_MS: number };
    await act(async () => { await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS); });
    expect(text()).toContain(EMPTY);
    expect(text()).toContain('usage history unavailable: no answer in 15 s');
    expect(retry()).toBeDefined();
  });

  it('stream ticks while a read is out read again once after it, not once each', async () => {
    const d = daemon();
    const useHopper = await render(d.fetch);
    expect(d.fetch).toHaveBeenCalledTimes(1);
    for (let n = 1; n <= 5; n++) await act(async () => { useHopper.setState({ recorded: { usage: n, machine: 0 } }); });
    expect(d.fetch).toHaveBeenCalledTimes(1);
    await act(async () => { d.answer(); });
    await vi.waitFor(() => expect(d.fetch).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(text()).toContain(EMPTY));
    expect(d.fetch).toHaveBeenCalledTimes(2);
  });
});
