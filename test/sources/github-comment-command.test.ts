// Issue #655, part 21: the nomination by a comment command (Decision N3). A labelled issue the source's account did not
// assign to itself is taken when that account's newest command on it, `/hopper run|research|propose`, was not edited and
// not written through an app; its origin act is `nominated` in place of `assigned`. `research` and `propose` ask the job
// for that kind. A command of anyone else nominates nothing.
import { describe, expect, it } from 'vitest';
import { NOT_ASSIGNED } from '../../src/sources/github/discover.ts';
import { REPO, setup } from './fixtures/github-support.ts';

describe('the comment command (issue #655, part 21)', () => {
  it('the account\'s /hopper run takes a labelled issue not assigned to it, nominated in place of assigned', async () => {
    const { gh, source } = setup();
    const issue = gh.createIssue({ repo: REPO, assignees: [], labels: ['hopper'] });
    gh.addComment(REPO, issue.number, 'owner', '/hopper run');
    const [item] = await source.discover();
    expect(item).toMatchObject({ key: issue.url, origin: 'trusted' });
    expect(item!.originActs).toContainEqual({ role: 'nominated', login: 'owner', trusted: true });
    expect(item!.originActs!.some((a) => a.role === 'assigned')).toBe(false);
    expect(item!.asks).toBeUndefined();
  });

  it('no command, or another login\'s, nominates nothing: the issue is not assigned to you', async () => {
    const { gh, source } = setup();
    const a = gh.createIssue({ repo: REPO, assignees: [], labels: ['hopper'] });
    const b = gh.createIssue({ repo: REPO, assignees: [], labels: ['hopper'] });
    gh.addComment(REPO, a.number, 'owner', 'Can the hopper run this?');
    gh.addComment(REPO, b.number, 'stranger', '/hopper run');
    expect(await source.discover()).toEqual([]);
    expect(source.intake?.().map((x) => x.reason)).toEqual([NOT_ASSIGNED, NOT_ASSIGNED]);
  });

  it('a command written through an app is a request card: nominated by an app', async () => {
    const { gh, source } = setup();
    const issue = gh.createIssue({ repo: REPO, assignees: [], labels: ['hopper'] });
    gh.addComment(REPO, issue.number, 'owner', '/hopper run', undefined, 'cursor');
    expect(await source.discover()).toEqual([]);
    expect(source.intake?.().find((x) => x.key === issue.url)).toMatchObject({ action: 'approve', request: { why: ['nominated by an app or a bot (cursor)'] } });
  });

  it('/hopper research and /hopper propose ask the job for that kind, on an assigned issue too', async () => {
    const { gh, source } = setup();
    const a = gh.createIssue({ repo: REPO, assignees: [], labels: ['hopper'] });
    const b = gh.createIssue({ repo: REPO, labels: ['hopper'] });
    gh.addComment(REPO, a.number, 'owner', '/hopper research');
    gh.addComment(REPO, b.number, 'owner', '/hopper propose\nThe paths are not clear.');
    const items = await source.discover();
    expect(items.map((i) => [i.number, i.asks])).toEqual([[a.number, ['research']], [b.number, ['proposal']]]);
    expect(items.find((i) => i.number === b.number)!.originActs!.some((x) => x.role === 'nominated')).toBe(false);
  });

  it('after a rejection, only a command written since takes the issue again', async () => {
    const rejections = (at: string) => (keys: string[]) => new Map(keys.map((k) => [k, { at, assignee: 'owner' }]));
    const before = setup({}, { rejections: rejections('2026-10-02T08:59:00.000Z') });
    const i1 = before.gh.createIssue({ repo: REPO, assignees: [], labels: ['hopper'] });
    before.gh.addComment(REPO, i1.number, 'owner', '/hopper run');
    expect((await before.source.discover()).map((i) => i.number)).toEqual([i1.number]);
    const after = setup({}, { rejections: rejections('2026-10-02T09:30:00.000Z') });
    const i2 = after.gh.createIssue({ repo: REPO, assignees: [], labels: ['hopper'] });
    after.gh.addComment(REPO, i2.number, 'owner', '/hopper run');
    expect(await after.source.discover()).toEqual([]);
  });
});
