// @vitest-environment happy-dom
// Issue #1194, part 8: Sources shows the GitHub work a person's acts left after their answer — on a source's card, how many
// GitHub writes are under way, when the last went through, and each that failed; and, for the whole hopper, how long the
// work after each act waited on its queue apart from its run (`afterAnswer` of GET /api/sources).
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { boot, source, unmount } from './sources-daemon.ts';
import { afterAnswerRows, ms } from '../../ui/src/model/after-answer.ts';

afterEach(unmount);

const KEY = 'https://github.com/owner/repo/issues/7';
const AT = new Date(Date.now() - 90_000).toISOString();
const text = (sel: string) => document.querySelector(sel)?.textContent ?? '';
const spread = (p50: number, p95: number, max = p95) => ({ p50, p95, max });

describe('Sources: the GitHub writes after an act (issue #1194)', () => {
  it('a source\'s card says how many GitHub writes are under way, when the last went through, and each that failed', async () => {
    const detail = { writeBehindPending: 2, lastWriteBehindAt: AT, writeBehindErrors: { [KEY]: 'assign: GitHub is down' } };
    await boot({ '/api/sources': { sources: [source('custom', 'custom', 'ok', detail)] } });
    await vi.waitFor(() => expect(text('[data-write-behind="custom"]')).toContain('2 under way'));
    expect(text('[data-write-behind="custom"]')).toMatch(/last went through 1m ago/);
    expect(text('[data-write-behind-error]')).toContain('assign: GitHub is down');
  });

  it('each failed row of the GitHub outbox is listed with a Retry, which sends it again (issue #1238)', async () => {
    const detail = { lastWriteBehindAt: AT, writeBehindErrors: { [KEY]: 'resolve: not allowed' },
      outboxFailed: [{ key: KEY, repo: 'owner/repo', act: 'resolve', error: 'not allowed', attempts: 1 }] };
    await boot({ '/api/sources': { sources: [source('custom', 'custom', 'ok', detail)] }, '/ui/api/sources/custom/intake': { done: [KEY], failed: {} } });
    const row = await vi.waitFor(() => { const r = document.querySelector('[data-outbox-failed]'); expect(r).not.toBeNull(); return r!; });
    expect(row.textContent).toContain('not allowed');
    const button = row.querySelector<HTMLButtonElement>('[data-outbox-retry]')!;
    await act(async () => { button.click(); });
    const posts = vi.mocked(fetch).mock.calls.filter(([path, init]) => String(path) === '/ui/api/sources/custom/intake' && init?.method === 'POST');
    expect(posts.map(([, init]) => JSON.parse(String(init!.body)))).toEqual([{ kind: 'retry_outbox', keys: [KEY] }]);
  });

  it('no line when no GitHub write ever ran', async () => {
    await boot({ '/api/sources': { sources: [source('custom', 'custom', 'ok', {})] } });
    await vi.waitFor(() => expect(document.querySelector('[data-source-sync="custom"]')).not.toBeNull());
    expect(document.querySelector('[data-write-behind]')).toBeNull();
  });

  it('the work after each act: its wait on the queue apart from its run', async () => {
    const afterAnswer = [
      { act: 'sync:approve', count: 3, waitMs: spread(3800, 3900), runMs: spread(7, 9), lastAt: AT },
      { act: 'approve', source: 'custom', count: 3, waitMs: spread(0, 1), runMs: spread(420, 1260), lastAt: AT },
    ];
    await boot({ '/api/sources': { sources: [source('custom', 'custom', 'ok', {})], afterAnswer } });
    await vi.waitFor(() => expect(document.querySelectorAll('[data-after-answer-act]')).toHaveLength(2));
    const rows = [...document.querySelectorAll('[data-after-answer-act]')].map((r) => r.textContent);
    // The slowest first: the sync waited behind the one already running.
    expect(rows[0]).toContain('sync:approve');
    expect(rows[0]).toContain('3.8 s');
    expect(rows[1]).toContain('approve · custom');
    expect(rows[1]).toContain('1.3 s');
  });

  it('no panel before any act ran', async () => {
    await boot({ '/api/sources': { sources: [source('custom', 'custom', 'ok', {})], afterAnswer: [] } });
    await vi.waitFor(() => expect(document.querySelector('[data-source-sync="custom"]')).not.toBeNull());
    expect(document.querySelector('[data-after-answer]')).toBeNull();
  });
});

describe('the after-answer rows (issue #1194)', () => {
  it('the slowest work first, by its p95 of wait and run together', () => {
    const rows = afterAnswerRows([
      { act: 'merge', count: 1, waitMs: spread(0, 0), runMs: spread(10, 10), lastAt: AT },
      { act: 'sync:rerun', count: 2, waitMs: spread(100, 200), runMs: spread(50, 60), lastAt: AT },
    ]);
    expect(rows.map((r) => r.name)).toEqual(['sync:rerun', 'merge']);
  });

  it('writes a time in ms under a second, else in seconds', () => {
    expect(ms(7)).toBe('7 ms');
    expect(ms(999)).toBe('999 ms');
    expect(ms(1260)).toBe('1.3 s');
  });
});
