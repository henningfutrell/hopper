// Issue #1141: a connected account's GitHub source lists the user's tagged items — the open issues and pull requests of the
// job repositories that ask for the user's review, mention the user, or are assigned to the user — at its sync. A pull
// request that newly asks for a review records `source.review_requested` once; it drops off when the request goes (the
// review given) or the pull request is no longer open (merged). A person may dismiss an item; what is kept survives a restart.
import { describe, expect, it } from 'vitest';
import type { TaggedRecord, TaggedWhy } from '../../src/domain/tagged.ts';
import type { TaggedSearchHit } from '../../src/sources/github/api.ts';
import { createFakeGitHub, createGitHubSource } from '../../src/sources/github/index.ts';
import { REPO, githubConfig, testTrust } from './fixtures/github-support.ts';

const pr = (n: number, why: TaggedWhy, o: Partial<TaggedSearchHit> = {}): TaggedSearchHit => ({
  key: `https://github.com/${REPO}/pull/${n}`, repo: REPO, number: n, kind: 'pull', title: `PR ${n}`, author: 'someone', why,
  createdAt: '2026-10-13T00:00:00.000Z', updatedAt: `2026-10-14T0${n}:00:00.000Z`, labels: [], checks: 'passing', isDraft: false, ...o,
});

function setup(kept: { record?: TaggedRecord } = {}) {
  const gh = createFakeGitHub();
  let hits: TaggedSearchHit[] = [];
  const asked: [string, string[]][] = [];
  gh.taggedItems = async (login, repos) => { asked.push([login, repos]); return hits; };
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const source = createGitHubSource({
    name: 'github', kind: 'github-account', whoami: 'owner', assignee: () => 'owner', config: githubConfig(), api: gh,
    trust: testTrust(), clock: { now: () => new Date('2026-10-14T10:00:00.000Z') }, knownKeys: () => new Set(),
    intake: {
      holder: 'a1b2c3d4e5f6', othersKnown: () => new Set(), migration: () => ({ at: '2026-10-08T09:00:00.000Z', changes: [] }), migrated: () => {},
      record: (type, data) => { events.push({ type, data }); }, requestOpened: () => false, requestsWaiting: () => [],
      tagged: { get: () => kept.record, set: (r) => { kept.record = r; } },
    },
  });
  const tagged = () => (source.describe().tagged as { number: number; why: TaggedWhy[] }[]).map((i) => [i.number, i.why]);
  return { gh, source, events, asked, tagged, set: (h: TaggedSearchHit[]) => { hits = h; }, kept };
}

describe('tagged items (issue #1141)', () => {
  it('a pull request that asks for the user\'s review is listed at the next sync, and drops off once reviewed or merged', async () => {
    const t = setup();
    t.set([pr(1, 'review'), pr(2, 'mention'), pr(1, 'mention')]);
    await t.source.discover();
    expect(t.asked).toEqual([['owner', [REPO]]]);
    expect(t.tagged()).toEqual([[2, ['mention']], [1, ['review', 'mention']]]);
    expect(t.events.filter((e) => e.type === 'source.review_requested').map((e) => e.data)).toEqual([
      { source: 'github', key: `https://github.com/${REPO}/pull/1`, author: 'someone' },
    ]);
    // Reviewed: GitHub drops the request; the mention stays.
    t.set([pr(2, 'mention'), pr(1, 'mention')]);
    await t.source.discover();
    expect(t.tagged()).toEqual([[2, ['mention']], [1, ['mention']]]);
    // Merged: no longer open, so no search finds it.
    t.set([pr(2, 'mention')]);
    await t.source.discover();
    expect(t.tagged()).toEqual([[2, ['mention']]]);
    expect(t.events.filter((e) => e.type === 'source.review_requested')).toHaveLength(1);
  });

  it('leaves out intake\'s items, the user\'s own pull requests, and repositories outside the job repositories', async () => {
    const t = setup();
    t.set([pr(1, 'assign', { labels: ['Hopper'] }), pr(2, 'assign', { author: 'Owner' }), pr(3, 'mention', { repo: 'other/repo' }),
      pr(4, 'assign', { kind: 'issue', author: 'owner', key: `https://github.com/${REPO}/issues/4` })]);
    await t.source.discover();
    expect(t.tagged()).toEqual([[4, ['assign']]]);
  });

  it('a person dismisses an item; a restart keeps the dismissal and records no review request again', async () => {
    const t = setup();
    t.set([pr(1, 'review'), pr(2, 'mention')]);
    await t.source.discover();
    expect(await t.source.intakeAction!({ kind: 'dismiss', keys: [`https://github.com/${REPO}/pull/1`, 'https://github.com/x/y/pull/9'] })).toEqual({
      done: [`https://github.com/${REPO}/pull/1`], failed: { 'https://github.com/x/y/pull/9': 'not a tagged item the last sync listed' },
    });
    expect(t.tagged()).toEqual([[2, ['mention']]]);
    expect(t.source.describe().taggedDismissed).toBe(1);
    const again = setup({ record: t.kept.record! });
    again.set([pr(1, 'review'), pr(2, 'mention')]);
    await again.source.discover();
    expect(again.tagged()).toEqual([[2, ['mention']]]);
    expect(again.events.filter((e) => e.type === 'source.review_requested')).toEqual([]);
  });

  it('a read that fails keeps the last list and says why', async () => {
    const t = setup();
    t.set([pr(1, 'review')]);
    await t.source.discover();
    t.gh.taggedItems = async () => { throw new Error('GraphQL: rate limited'); };
    await t.source.discover();
    expect(t.tagged()).toEqual([[1, ['review']]]);
    expect(t.source.describe().taggedError).toBe('GraphQL: rate limited');
  });

  it('keeps the job a person started on an item, once; a restart keeps it, and it goes when the item does (issue #2342)', async () => {
    const t = setup();
    t.set([pr(1, 'review'), pr(2, 'mention')]);
    await t.source.discover();
    const key = `https://github.com/${REPO}/pull/1`;
    const started = { key, start: 'research' as const, directJob: 'd1', jobId: 'j1', at: '2026-10-14T10:00:00.000Z' };
    expect(await t.source.intakeAction!({ kind: 'tagged_start', keys: [key], started })).toEqual({ done: [key], failed: {} });
    expect(await t.source.intakeAction!({ kind: 'tagged_start', keys: [key], started: { ...started, directJob: 'd2' } }))
      .toEqual({ done: [], failed: { [key]: 'already started: direct job d1' } });
    const shown = t.source.describe().tagged as { number: number; started?: unknown }[];
    expect(shown.map((i) => [i.number, i.started])).toEqual([[2, undefined], [1, { start: 'research', directJob: 'd1', jobId: 'j1', at: started.at }]]);
    const again = setup({ record: t.kept.record! });
    again.set([pr(2, 'mention')]);
    await again.source.discover();
    expect(again.kept.record!.started).toEqual([]);
  });
});
