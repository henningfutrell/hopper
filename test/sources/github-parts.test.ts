// Declared parts (issue #729). An issue declares its parts as a checklist under a heading "Parts". A part is done when
// its box is ticked, and each merged "Part of #N" pull request ticks one more: done is the larger of the two, never more
// than the parts. The job's prompt says how many parts are done, and the job card shows it (x/y). When a merged part
// makes every declared part done, the issue is done (`hopper:done`): it is not offered again.
import { describe, expect, it } from 'vitest';
import { declaredParts } from '../../src/sources/github/parts.ts';
import { REPO, discoverOne, jobForIssue, setup } from './fixtures/github-support.ts';

const AFTER = '2026-10-02T11:00:00.000Z';
const PARTS = ['Make the thing.', '', '## Parts', '- [x] the model', '- [ ] the API', '* [ ] the UI', '', '## Notes', '- [ ] not a part'].join('\n');

describe('declared parts', () => {
  it('are the checklist under a heading "Parts", up to the next heading of its level or higher', () => {
    expect(declaredParts(PARTS)).toEqual({ total: 3, ticked: 1 });
    expect(declaredParts('### parts\n1. [X] one\n2. [ ] two\n#### detail\n- [ ] three')).toEqual({ total: 3, ticked: 1 });
  });

  it('none without a heading "Parts": a checklist elsewhere is not parts', () => {
    expect(declaredParts('Do it.\n\n- [ ] one\n- [ ] two')).toBeUndefined();
    expect(declaredParts('## Parts\n\nNo checklist here.')).toBeUndefined();
  });

  it('a checklist in a code block is not parts', () => {
    expect(declaredParts('## Parts\n```\n- [ ] one\n```\n- [ ] two')).toEqual({ total: 1, ticked: 0 });
  });
});

describe('an issue with declared parts', () => {
  function withParts() {
    const s = setup();
    s.gh.createIssue({ repo: REPO, labels: ['hopper'], body: PARTS });
    return s;
  }

  it('is offered with its parts done: the ticked ones, or more when more parts merged', async () => {
    const { gh, source } = withParts();
    expect((await discoverOne(source)).parts).toEqual({ done: 1, total: 3 });
    for (const at of [AFTER, '2026-10-02T12:00:00.000Z']) gh.mergePullRequest(gh.openPartPullRequest(REPO, 1, { createdAt: at }).url);
    const item = await discoverOne(source);
    expect(item.parts).toEqual({ done: 2, total: 3 });
    expect(item.prompt).toContain('parts: 2 of 3 done');
    expect(item.prompt).toContain('use "Closes #1" only when it ships the last part');
  });

  it('an issue with no parts says nothing about parts', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    const item = await discoverOne(source);
    expect(item.parts).toBeUndefined();
    expect(item.prompt).not.toContain('parts:');
  });

  function followed(gh: ReturnType<typeof setup>['gh']) {
    const pr = gh.openPartPullRequest(REPO, 1, { createdAt: AFTER });
    gh.addLabel(REPO, 1, 'hopper:partly-done');
    return { pr, job: jobForIssue(1, { status: 'finished', partlyDone: pr.url, sourceState: { source: { pullRequest: pr.url, follow: 'open', part: true } } }) };
  }

  it('a merged part that leaves parts to do: the issue is offered again, the parts done kept', async () => {
    const { gh, source } = withParts();
    const { pr, job } = followed(gh);
    gh.mergePullRequest(pr.url);
    expect(await source.follow!(job)).toEqual({
      outcome: 'merged', pullRequest: pr.url, part: true, state: { pullRequest: pr.url, follow: 'merged', part: true, parts: { done: 1, total: 3 } },
    });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
  });

  it('a merged part that makes every part done: the issue is done, not offered again', async () => {
    const { gh, source } = withParts();
    gh.editIssue(REPO, 1, { body: PARTS.replace('- [ ] the API', '- [x] the API') }, 'owner');
    gh.mergePullRequest(gh.openPartPullRequest(REPO, 1, { createdAt: '2026-10-02T10:30:00.000Z' }).url);
    gh.mergePullRequest(gh.openPartPullRequest(REPO, 1, { createdAt: '2026-10-02T10:40:00.000Z' }).url);
    const { pr, job } = followed(gh);
    gh.mergePullRequest(pr.url);
    expect(await source.follow!(job)).toMatchObject({ outcome: 'merged', part: true, state: { parts: { done: 3, total: 3 } } });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:done']);
    expect(await source.discover()).toEqual([]);
  });
});
