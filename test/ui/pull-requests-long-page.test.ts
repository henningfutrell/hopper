// @vitest-environment happy-dom
// The Pull requests view as a long page (issue #2353): Cards or Rows, a row one line; a repository group folds; a group
// past one page pages (10 cards or 40 rows to a page); the header with the mode stays in view; the mode and a fold are kept
// over a reload.
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import type { PullRequestsView } from '../../src/domain/types.ts';
import { boot, card, fixture, text, unmount } from './pull-requests-view-harness.ts';

const many = (n: number): PullRequestsView => ({
  ...fixture,
  repos: [{ repo: 'owner/a', yolo: false, pullRequests: Array.from({ length: n }, (_, i) => card({ jobId: `j${i}`, pullRequest: { number: 100 + i, url: `https://github.com/owner/a/pull/${100 + i}` } })) }],
});

const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); };
const shown = () => document.querySelectorAll('[data-repo="owner/a"] [data-pull-request]').length;
const range = () => text('[data-repo="owner/a"] [data-slot="pager-range"]');

describe('Pull requests view: a long page (issue #2353)', () => {
  it('pages 100 cards 10 to a page, and 40 rows to a page in Rows', async () => {
    await boot(many(100));
    expect(shown()).toBe(10);
    expect(range()).toBe('1–10 of 100');
    await click(document.querySelector('[data-repo="owner/a"] [data-slot="pager-more"]')!);
    expect(range()).toBe('11–20 of 100');
    await click(document.querySelector('[data-slot="pr-mode-rows"]')!);
    expect(document.querySelectorAll('[data-slot="pr-row"]')).toHaveLength(40);
    expect(range()).toBe('1–40 of 100');
  });

  it('a row is one line: number, what it closes, state, checks, conflicts, what it waits on; no acts or diff', async () => {
    await boot(fixture);
    await click(document.querySelector('[data-slot="pr-mode-rows"]')!);
    const row = document.querySelector('[data-pull-request="j1"]')!;
    expect(row.getAttribute('data-slot')).toBe('pr-row');
    expect(row.textContent).toContain('#11');
    expect(text('[data-slot="pr-checks"]', row)).toBe('checks pass');
    expect(row.querySelector('[data-slot="pr-actions"]')).toBeNull();
    expect(row.querySelector('div')).toBeNull();
  });

  it('keeps the header with the mode in view', async () => {
    await boot(fixture);
    const header = document.querySelector('[data-slot="panel-header"][data-sticky]')!;
    expect(header.className).toContain('sticky');
    expect(header.querySelector('[data-slot="pr-mode-cards"]')).not.toBeNull();
  });

  it('a group folds, and the fold and the mode are kept over a reload', async () => {
    await boot(fixture);
    await click(document.querySelector('[data-slot="pr-mode-rows"]')!);
    await click(document.querySelector('[data-repo="org/b"] [data-slot="panel-toggle"]')!);
    expect(document.querySelector('[data-pull-request="j3"]')).toBeNull();
    expect(document.querySelector('[data-pull-request="j1"]')).not.toBeNull();
    await unmount();
    await boot(fixture, 'admin', { repos: [] }, [], true);
    expect(document.querySelector('[data-slot="pr-mode-rows"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[data-repo="org/b"] [data-slot="panel-toggle"]')?.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-pull-request="j3"]')).toBeNull();
    await click(document.querySelector('[data-repo="org/b"] [data-slot="panel-toggle"]')!);
    expect(document.querySelector('[data-pull-request="j3"]')).not.toBeNull();
  });
});
