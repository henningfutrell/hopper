// Issue #159: several hoppers, one GitHub. An issue labelled `hopper@<name>` is addressed to the
// hopper whose source has that `hopperName`; only that one takes it. An unaddressed issue goes to
// any hopper. A rejected issue (`hopper:rejected`) is never taken while the label is set.
import { describe, expect, it } from 'vitest';
import { REPO, jobForIssue, setup } from './fixtures/github-support.ts';

describe('GitHub source: which hopper takes an issue', () => {
  it('an addressed issue goes only to the hopper of that name; an unaddressed one to any', async () => {
    const laptop = setup({ hopperName: 'laptop' });
    laptop.gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper@laptop'] });
    laptop.gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper@server'] });
    laptop.gh.createIssue({ repo: REPO, labels: ['hopper'] });
    laptop.gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper@server', 'hopper@laptop'] });
    expect((await laptop.source.discover()).map((i) => i.number)).toEqual([1, 3, 4]);
  });

  it('a hopper with no name takes no addressed issue', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper@laptop'] });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    expect((await source.discover()).map((i) => i.number)).toEqual([2]);
  });

  it('the hopper\'s name is in the source status', () => {
    const { source } = setup({ hopperName: 'laptop' });
    expect(source.describe()).toMatchObject({ hopperName: 'laptop' });
  });
});

describe('GitHub source: rejected', () => {
  it('report rejected: the claim label goes, no hopper:rejected (issue #387); the issue stays open', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    const job = jobForIssue(1);
    await source.report({ kind: 'claimed', job });
    await source.report({ kind: 'rejected', job: { ...job, status: 'rejected' } });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
    expect(gh.issue(REPO, 1).state).toBe('open');
    expect(gh.commentsOn(REPO, 1)).toEqual([]);
  });

  it('an issue labelled hopper:rejected before issue #387 is not taken while the label is set; removing it takes it in again', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:rejected'] });
    expect(await source.discover()).toEqual([]);
    gh.removeLabel(REPO, 1, 'hopper:rejected');
    expect((await source.discover()).map((i) => i.number)).toEqual([1]);
  });
});
