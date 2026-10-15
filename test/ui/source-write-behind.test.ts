// @vitest-environment happy-dom
// Issue #1194, part 8: Sources shows the GitHub work a person's acts left after their answer — on a source's card, how many
// GitHub writes are under way, when the last went through, and each that failed; and, for the whole hopper, how long the
// work after each act waited on its queue apart from its run (`afterAnswer` of GET /api/sources).
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
    const detail = { mode: 'app', writeBehindPending: 2, lastWriteBehindAt: AT, writeBehindErrors: { [KEY]: 'assign: GitHub is down' } };
    await boot({ '/api/sources': { sources: [source('github-app', 'github-app', 'ok', detail)] } });
    await vi.waitFor(() => expect(text('[data-write-behind="github-app"]')).toContain('2 under way'));
    expect(text('[data-write-behind="github-app"]')).toMatch(/last went through 1m ago/);
    expect(text('[data-write-behind-error]')).toContain('assign: GitHub is down');
  });

  it('no line when no GitHub write ever ran', async () => {
    await boot({ '/api/sources': { sources: [source('github-app', 'github-app', 'ok', { mode: 'app' })] } });
    await vi.waitFor(() => expect(document.querySelector('[data-source-sync="github-app"]')).not.toBeNull());
    expect(document.querySelector('[data-write-behind]')).toBeNull();
  });

  it('the work after each act: its wait on the queue apart from its run', async () => {
    const afterAnswer = [
      { act: 'sync:approve', count: 3, waitMs: spread(3800, 3900), runMs: spread(7, 9), lastAt: AT },
      { act: 'approve', source: 'github-app', count: 3, waitMs: spread(0, 1), runMs: spread(420, 1250), lastAt: AT },
    ];
    await boot({ '/api/sources': { sources: [source('github-app', 'github-app', 'ok', { mode: 'app' })], afterAnswer } });
    await vi.waitFor(() => expect(document.querySelectorAll('[data-after-answer-act]')).toHaveLength(2));
    const rows = [...document.querySelectorAll('[data-after-answer-act]')].map((r) => r.textContent);
    expect(rows[0]).toContain('approve · github-app');
    expect(rows[0]).toContain('1.3 s');
    expect(rows[1]).toContain('sync:approve');
    expect(rows[1]).toContain('3.8 s');
  });

  it('no panel before any act ran', async () => {
    await boot({ '/api/sources': { sources: [source('github-app', 'github-app', 'ok', { mode: 'app' })], afterAnswer: [] } });
    await vi.waitFor(() => expect(document.querySelector('[data-source-sync="github-app"]')).not.toBeNull());
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
    expect(ms(1250)).toBe('1.3 s');
  });
});
