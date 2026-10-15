// @vitest-environment happy-dom
// A pull request's diff on the Pull requests page (issue #1169): an operator opens it on a card or a landing card, the
// view reads it through the hopper (POST /ui/api/pull-requests/diff) and shows it in a code block in diff mode — each
// file's header and hunk marked, added and removed lines as such —, with copy and a wrap toggle. A viewer is not offered it.
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { LandingCard } from '../../src/domain/types.ts';
import type { PullRequestDiff } from '../../src/domain/pull-request-diff.ts';
import { diffLinesOf, diffSummary } from '../../ui/src/model/pull-request-diff.ts';
import { boot, cardOf, fixture, uiAnswers } from './pull-requests-view-harness.ts';

const DIFF = 'diff --git a/src/queue.ts b/src/queue.ts\n--- a/src/queue.ts\n+++ b/src/queue.ts\n@@ -1,2 +1,2 @@\n keep()\n-slow()\n+fast()\n'
  + 'diff --git a/logo.png b/logo.png\n--- /dev/null\n+++ b/logo.png\n(no patch: binary, or too large for GitHub to show)\n';

const answer = (number: number): PullRequestDiff => ({
  number, url: `https://github.com/owner/a/pull/${number}`, diff: DIFF,
  files: [{ file: 'src/queue.ts', status: 'modified', additions: 1, deletions: 1 }, { file: 'logo.png', status: 'added', additions: 0, deletions: 0 }],
});

describe('a pull request\'s diff', () => {
  it('reads each line of a diff as a file header, a hunk, an added, a removed or an unchanged line', () => {
    expect(diffLinesOf(DIFF).map((l) => l.kind)).toEqual(['file', 'file', 'file', 'hunk', 'same', 'removed', 'added', 'file', 'file', 'file', 'file']);
    // A removed line that reads as a header line is still a removed line inside a hunk.
    expect(diffLinesOf('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n--- old\n+++ new\n').map((l) => l.kind)).toEqual(['file', 'file', 'file', 'hunk', 'removed', 'added']);
    expect(diffLinesOf('')).toEqual([]);
    expect(diffSummary(answer(11))).toBe('2 files, +1 −1');
    expect(diffSummary({ ...answer(11), files: [answer(11).files[0]!], truncated: true })).toBe('1 file, +1 −1, cut short');
  });

  it('an operator opens it on a card: the code block marks the files, the hunks and the changed lines', async () => {
    uiAnswers['/ui/api/pull-requests/diff'] = answer(11);
    const daemon = await boot(fixture);
    const open = cardOf('j1').querySelector<HTMLButtonElement>('[data-slot="pr-diff-toggle"]')!;
    expect(open.textContent).toBe('Show diff');
    expect(open.getAttribute('aria-expanded')).toBe('false');
    await act(async () => open.click());
    await vi.waitFor(() => expect(cardOf('j1').querySelector('[data-slot="pr-diff"] [data-slot="code-block"]')).not.toBeNull());
    expect(daemon.bodies.find((b) => b.path === '/ui/api/pull-requests/diff')?.body).toEqual({ repo: 'owner/a', number: 11 });
    const diff = cardOf('j1').querySelector('[data-slot="pr-diff"]')!;
    expect(diff.querySelector('[data-slot="code-block-title"]')!.textContent).toBe('#11: 2 files, +1 −1');
    const lines = [...diff.querySelectorAll('[data-slot="code-block-line"]')];
    expect(lines.map((l) => l.getAttribute('data-change'))).toEqual(['file', 'file', 'file', 'hunk', 'same', 'removed', 'added', 'file', 'file', 'file', 'file']);
    expect(lines[5]!.getAttribute('data-variant')).toBe('removed');
    expect(lines[6]!.getAttribute('data-variant')).toBe('added');
    expect(lines[3]!.getAttribute('data-variant')).toBe('highlighted');
    expect(diff.querySelector('[aria-label="Copy"]')).not.toBeNull();
    expect(diff.querySelector('[aria-label="Wrap long lines"]')).not.toBeNull();
    expect(open.getAttribute('aria-expanded')).toBe('true');
    await act(async () => open.click());
    expect(cardOf('j1').querySelector('[data-slot="pr-diff"]')).toBeNull();
    // A card with no pull request yet has nothing to show.
    expect(cardOf('j2').querySelector('[data-slot="pr-diff-toggle"]')).toBeNull();
  });

  it('a landing card opens its pull request\'s diff too, a bisect\'s culprit among them', async () => {
    uiAnswers['/ui/api/pull-requests/diff'] = answer(12);
    const landing: LandingCard = {
      jobId: 'j12', repo: 'owner/a', issue: 'https://github.com/owner/a/issues/1', pullRequest: { number: 12, url: 'https://github.com/owner/a/pull/12' },
      stage: 'culprit', since: '2026-10-08T10:00:00.000Z',
    };
    const daemon = await boot({ ...fixture, landing: [landing] });
    await vi.waitFor(() => expect(document.querySelector('[data-landing="j12"]')).not.toBeNull());
    const row = () => document.querySelector('[data-landing="j12"]')!;
    await act(async () => row().querySelector<HTMLButtonElement>('[data-slot="pr-diff-toggle"]')!.click());
    await vi.waitFor(() => expect(row().querySelector('[data-slot="pr-diff"] [data-slot="code-block"]')).not.toBeNull());
    expect(daemon.bodies.find((b) => b.path === '/ui/api/pull-requests/diff')?.body).toEqual({ repo: 'owner/a', number: 12 });
  });

  it('a viewer is not offered it', async () => {
    await boot(fixture, 'viewer');
    expect(document.querySelector('[data-slot="pr-diff-toggle"]')).toBeNull();
  });
});
