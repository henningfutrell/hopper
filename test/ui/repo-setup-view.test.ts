// @vitest-environment happy-dom
// Issue #652 requirement 8: Sources warns of each job repository whose setup is not as the hopper asks (its default and
// release branches need a pull request and a status check and take no force push; secret scanning and push protection
// on), names each problem, and says what GitHub did not show. Rendered in the whole app against a fake daemon.
import { act } from 'react';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { RepoChecks } from '../../src/domain/types.ts';
import { setupLine } from '../../ui/src/model/repo-setup.ts';
import { boot, unmount } from './sources-daemon.ts';

afterEach(unmount);

const repo = (name: string, setup: RepoChecks['setup']): RepoChecks => ({
  repo: name, state: 'checks', yolo: true, dismissed: false, checkedAt: '2026-10-11T10:00:00.000Z',
  found: { required: ['pr / test'], workflows: [], pullRequests: { read: 1, withChecks: 1 } }, setup,
});
const GOOD = repo('octo/good', { state: 'set up', problems: [], unread: [] });
const LOOSE = repo('octo/loose', { state: 'not set up', problems: ['dev takes a push with no pull request', 'secret scanning is off'], unread: ['whether push protection is on'] });
const RULED = repo('octo/ruled', { state: 'unknown', problems: [], unread: ['whether secret scanning is on'] });

const section = () => document.querySelector('[aria-labelledby="sources-repo-setup"]');
const row = (name: string) => section()?.querySelector(`[data-repo-setup-repo="${name}"]`);

describe('Sources: repository setup', () => {
  it('warns of a repository not set up, with each problem, and says what GitHub did not show', async () => {
    await boot({ '/api/repo-checks': { repos: [GOOD, LOOSE, RULED] } });
    await vi.waitFor(() => expect(section()).not.toBeNull());
    expect(section()!.querySelector('h2')?.textContent).toBe('Repository setup');
    expect(section()!.querySelector('[data-repo-setup-line]')?.textContent).toBe('Not set up: octo/loose. Not known: octo/ruled.');
    expect(row('octo/loose')?.getAttribute('data-repo-setup')).toBe('not set up');
    expect([...row('octo/loose')!.querySelectorAll('[data-repo-setup-problem]')].map((p) => p.textContent))
      .toEqual(['dev takes a push with no pull request', 'secret scanning is off']);
    expect(row('octo/loose')!.textContent).toContain('GitHub did not show: whether push protection is on');
    expect(row('octo/ruled')?.getAttribute('data-repo-setup')).toBe('unknown');
    expect(row('octo/ruled')!.textContent).toContain('only to a repository admin');
    expect(row('octo/good')?.getAttribute('data-repo-setup')).toBe('set up');
    expect(row('octo/good')!.querySelector('[data-repo-setup-problem]')).toBeNull();
  });

  it('shows when each repository was read, and Refresh asks the daemon to read GitHub again (issue #1250)', async () => {
    const NEW = { ...repo('octo/new', { state: 'unknown', problems: [], unread: [] }), state: 'unknown' as const };
    delete NEW.checkedAt;
    delete NEW.found;
    await boot({ '/api/repo-checks': { repos: [GOOD, NEW] }, '/ui/api/repo-checks/refresh': { repos: [{ ...GOOD, reading: true }, { ...NEW, reading: true }] } });
    await vi.waitFor(() => expect(section()).not.toBeNull());
    expect(row('octo/good')!.querySelector('[data-repo-setup-read]')?.getAttribute('datetime')).toBe(GOOD.checkedAt);
    expect(row('octo/new')!.querySelector('[data-repo-setup-read]')?.textContent).toBe('not read yet');
    const refresh = section()!.querySelector<HTMLButtonElement>('[data-repo-setup-refresh]')!;
    expect(refresh.textContent).toBe('Refresh');
    const fetch = globalThis.fetch as unknown as Mock;
    expect(fetch.mock.calls.some(([u, init]) => String(u) === '/ui/api/repo-checks/refresh' && (init as RequestInit | undefined)?.method === 'POST')).toBe(false);
    await act(async () => { refresh.click(); });
    await vi.waitFor(() => expect(fetch.mock.calls.some(([u, init]) => String(u) === '/ui/api/repo-checks/refresh' && (init as RequestInit | undefined)?.method === 'POST')).toBe(true));
    await vi.waitFor(() => expect(row('octo/new')!.querySelector('[data-repo-setup-read]')?.textContent).toBe('reading GitHub…'));
  });

  it('shows no section when there is no job repository, or the checks cannot be read', async () => {
    await boot({ '/api/repo-checks': { repos: [] } });
    await vi.waitFor(() => expect(document.querySelector('[data-github-summary]')).not.toBeNull());
    expect(section()).toBeNull();
    await unmount();
    await boot();
    await vi.waitFor(() => expect(document.querySelector('[data-github-summary]')).not.toBeNull());
    expect(section()).toBeNull();
  });
});

describe('setupLine', () => {
  it('names the repositories not set up, then those not known; all set up says so', () => {
    expect(setupLine([GOOD, LOOSE, RULED])).toBe('Not set up: octo/loose. Not known: octo/ruled.');
    expect(setupLine([GOOD])).toBe('Every job repository is set up.');
    expect(setupLine([RULED])).toBe('Not known: octo/ruled.');
  });
});
