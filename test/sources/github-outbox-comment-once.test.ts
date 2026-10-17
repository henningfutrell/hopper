// Issue #1590: a comment row of the GitHub outbox is posted once. A stop after GitHub took the comment and before its row
// was `sent` leaves the row `sending`; the next start sends it again, and the comment GitHub already holds answers it in
// place of a second one. Labels and assignees are idempotent; a comment is not.
import { describe, expect, it } from 'vitest';
import type { GitHubApi } from '../../src/sources/github/api.ts';
import { createFakeGitHub } from '../../src/sources/github/index.ts';
import { createGitHubOutbox, memoryGitHubOutbox, outboxSend } from '../../src/sources/github/outbox.ts';
import { REPO } from './fixtures/github-support.ts';

const clock = { now: () => new Date('2026-10-17T10:00:00.000Z') };
const url = (n: number) => `https://github.com/${REPO}/issues/${n}`;
const noRead = async () => {};

/** A GitHub that takes a comment and then never answers: the hopper stopped before its row was updated. */
const stopsAfterPost = (gh: GitHubApi): GitHubApi => new Proxy(gh, {
  get(target, prop, receiver) {
    const v = Reflect.get(target, prop, receiver) as unknown;
    if (prop !== 'postComment' || typeof v !== 'function') return v;
    return async (...args: unknown[]) => { await (v as (...a: unknown[]) => unknown).apply(target, args); return new Promise(() => {}); };
  },
});

describe('the outbox posts a comment once (issue #1590)', () => {
  it('a stop between the post and the row\'s update: after the start, the issue has one comment', async () => {
    const gh = createFakeGitHub();
    gh.createIssue({ repo: REPO, assignees: [], labels: ['hopper'] });
    const rows = memoryGitHubOutbox();
    const before = createGitHubOutbox({ source: 'github', rows, clock });
    before.queue('resolve', url(1), REPO, [{ change: { op: 'comment', body: 'Resolved from Needs a person: done by hand.' } }], { tag: 'j1@1' });
    void before.flush(outboxSend(stopsAfterPost(gh), noRead));
    await new Promise((res) => setTimeout(res, 10));
    expect(await gh.listComments(REPO, 1)).toHaveLength(1);

    const after = createGitHubOutbox({ source: 'github', rows, clock });
    expect(await after.flush(outboxSend(gh, noRead))).toEqual({ due: 1, wrote: [REPO] });
    const comments = await gh.listComments(REPO, 1);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain('Resolved from Needs a person: done by hand.');
    expect(after.resolution(url(1), 'j1@1')).toEqual({ state: 'written' });
  });

  it('two rows of the same text sent at different times are two comments', async () => {
    const gh = createFakeGitHub();
    gh.createIssue({ repo: REPO, assignees: [], labels: ['hopper'] });
    const outbox = createGitHubOutbox({ source: 'github', rows: memoryGitHubOutbox(), clock });
    outbox.queue('resolve', url(1), REPO, [{ change: { op: 'comment', body: 'Resolved.' } }], { tag: 'j1@1' });
    await outbox.flush(outboxSend(gh, noRead));
    outbox.queue('resolve', url(1), REPO, [{ change: { op: 'comment', body: 'Resolved.' } }], { tag: 'j1@2' });
    await outbox.flush(outboxSend(gh, noRead));
    expect(await gh.listComments(REPO, 1)).toHaveLength(2);
  });
});
