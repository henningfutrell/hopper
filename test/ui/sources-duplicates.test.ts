// @vitest-environment happy-dom
// Duplicate GitHub sources on Sources (issue #1264): a banner names each duplicate, its card is marked, and one click
// removes it from the plugins config. Each card shows its poll interval, the interval to its next poll when it backed
// off, and its GitHub calls in the last hour and day.
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { boot, source, unmount } from './sources-daemon.ts';

afterEach(unmount);

const text = (sel: string) => document.querySelector(sel)?.textContent ?? '';
const PLUGINS = { config: { version: 'v1', warnings: [] }, instances: [], plugins: [], errors: [], warnings: [] };
const app = (name: string, over: Record<string, unknown> = {}) => ({ ...source(name, 'custom', 'ok', {}), ...over });

describe('Sources: duplicate GitHub sources (issue #1264)', () => {
  it('a duplicate shows a banner and a marker on its card; Remove sends its removal', async () => {
    const account = (name: string, over: Record<string, unknown> = {}) => ({ ...source(name, 'github-account', 'ok', { login: 'octo-user' }), ...over });
    await boot({
      '/api/sources': { sources: [account('github-account'), account('gh-2', { duplicateOf: 'github-account' })] },
      '/api/plugins': PLUGINS, '/ui/api/plugins': PLUGINS,
    });
    await vi.waitFor(() => expect(text('[data-duplicate-sources]')).toContain('gh-2'));
    expect(text('[data-duplicate-sources]')).toContain('github-account');
    expect(document.querySelector('[data-duplicate-of="gh-2"]')).not.toBeNull();
    expect(document.querySelector('[data-duplicate-of="github-account"]')).toBeNull();
    const remove = document.querySelector<HTMLButtonElement>('[data-remove-duplicate="gh-2"]')!;
    await act(async () => { remove.click(); });
    const posted = () => vi.mocked(fetch).mock.calls.find(([url, init]) => String(url) === '/ui/api/plugins' && init?.method === 'POST');
    await vi.waitFor(() => expect(posted()).toBeDefined());
    expect(JSON.parse(String(posted()![1]!.body))).toEqual({ action: 'remove', role: 'job-source', name: 'gh-2', version: 'v1' });
  });

  it('no banner when no source is a duplicate', async () => {
    await boot({ '/api/sources': { sources: [app('custom')] } });
    await vi.waitFor(() => expect(document.querySelector('[data-source-sync="custom"]')).not.toBeNull());
    expect(document.querySelector('[data-duplicate-sources]')).toBeNull();
  });

  it('a card shows its poll interval, its backed-off next poll and its GitHub calls', async () => {
    await boot({ '/api/sources': { sources: [app('custom', { pollMs: 60_000, nextPollMs: 240_000, calls: { lastHour: 42, lastDay: 900 } })] } });
    await vi.waitFor(() => expect(text('[data-poll="custom"]')).toContain('every 1m'));
    expect(text('[data-poll="custom"]')).toContain('4m');
    expect(text('[data-calls="custom"]')).toContain('42');
    expect(text('[data-calls="custom"]')).toContain('900');
  });
});
