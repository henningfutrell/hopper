// Declared parts (issue #729). An issue declares its parts as a checklist under a heading "Parts". A part is done when
// its box is ticked, and each merged "Part of #N" pull request ticks one more: done is the larger of the two, never more
// than the parts. A part that names an issue is a required child: it is done only when that issue is closed. An issue's
// GitHub sub-issues are parts too (a job's required child is one): a closed sub-issue is a done part, and one a checklist
// item names counts once. The job's prompt
// says how many parts are done, and the job card shows it (x/y). When a merged part makes every declared part done, the
// issue is done (`hopper:done`): it is not offered again.
import { describe, expect, it } from 'vitest';
import { issueFrom, subIssueFrom } from '../../src/sources/github/app/rest.ts';
import { declaredParts } from '../../src/sources/github/parts.ts';
import { REPO, discoverOne, jobForIssue, setup } from './fixtures/github-support.ts';

const AFTER = '2026-10-02T11:00:00.000Z';
const PARTS = ['Make the thing.', '', '## Parts', '- [x] the model', '- [ ] the API', '* [ ] the UI', '', '## Notes', '- [ ] not a part'].join('\n');

describe('declared parts', () => {
  it('are the checklist under a heading "Parts", up to the next heading of its level or higher', () => {
    expect(declaredParts(PARTS, REPO)).toEqual([{ ticked: true }, { ticked: false }, { ticked: false }]);
    expect(declaredParts('### parts\n1. [X] one\n2. [ ] two\n#### detail\n- [ ] three', REPO)).toEqual([{ ticked: true }, { ticked: false }, { ticked: false }]);
  });

  it('none without a heading "Parts": a checklist elsewhere is not parts', () => {
    expect(declaredParts('Do it.\n\n- [ ] one\n- [ ] two', REPO)).toBeUndefined();
    expect(declaredParts('## Parts\n\nNo checklist here.', REPO)).toBeUndefined();
  });

  it('a checklist in a code block is not parts', () => {
    expect(declaredParts('## Parts\n```\n- [ ] one\n```\n- [ ] two', REPO)).toEqual([{ ticked: false }]);
  });

  it('a part that starts with an issue names it: #N, owner/repo#N or its URL; an issue named later in the text does not', () => {
    const body = ['## Parts', '- [ ] #12', '- [x] other/repo#3 the docs', '- [ ] https://github.com/other/repo/issues/5', '- [ ] the API (see #12)'].join('\n');
    expect(declaredParts(body, REPO)).toEqual([
      { ticked: false, issue: { repo: REPO, number: 12 } },
      { ticked: true, issue: { repo: 'other/repo', number: 3 } },
      { ticked: false, issue: { repo: 'other/repo', number: 5 } },
      { ticked: false },
    ]);
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

describe('required children: a part that names an issue', () => {
  function withChildren() {
    const s = setup();
    s.gh.createIssue({ repo: REPO, labels: ['hopper'], body: ['## Parts', '- [x] #2', '- [ ] #3 the fix', '- [x] the docs'].join('\n') });
    s.gh.createIssue({ repo: REPO });
    s.gh.createIssue({ repo: REPO });
    return s;
  }

  it('is done only when that issue is closed: its tick does not count', async () => {
    const { gh, source } = withChildren();
    expect((await discoverOne(source)).parts).toEqual({ done: 1, total: 3 });
    gh.closeIssue(REPO, 2);
    gh.closeIssue(REPO, 3, undefined, { reason: 'not_planned' });
    expect((await discoverOne(source)).parts).toEqual({ done: 3, total: 3 });
  });

  it('a named issue that cannot be read counts by its tick, read again next sync', async () => {
    const { gh, source } = withChildren();
    await discoverOne(source); // the issue itself is read, and kept while its listing shows no change
    gh.failNext('getIssue', new Error('gh: Not Found (HTTP 404)'));
    expect((await discoverOne(source)).parts).toEqual({ done: 2, total: 3 });
  });

  it('a merged pull request of a part counts only for a part that names no issue', async () => {
    const { gh, source } = withChildren();
    gh.editIssue(REPO, 1, { body: ['## Parts', '- [ ] #2', '- [ ] the docs'].join('\n') }, 'owner');
    for (const at of [AFTER, '2026-10-02T12:00:00.000Z']) gh.mergePullRequest(gh.openPartPullRequest(REPO, 1, { createdAt: at }).url);
    expect((await discoverOne(source)).parts).toEqual({ done: 1, total: 2 });
  });

  it('a merged part leaves the issue to do while a required child is open, and makes it done once that child is closed', async () => {
    const { gh, source } = withChildren();
    gh.closeIssue(REPO, 2);
    const part = (at: string) => {
      const pr = gh.openPartPullRequest(REPO, 1, { createdAt: at });
      gh.mergePullRequest(pr.url);
      return jobForIssue(1, { status: 'finished', partlyDone: pr.url, sourceState: { source: { pullRequest: pr.url, follow: 'open', part: true } } });
    };
    expect(await source.follow!(part(AFTER))).toMatchObject({ outcome: 'merged', part: true, state: { parts: { done: 2, total: 3 } } });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
    gh.closeIssue(REPO, 3);
    expect(await source.follow!(part('2026-10-02T12:00:00.000Z'))).toMatchObject({ outcome: 'merged', part: true, state: { parts: { done: 3, total: 3 } } });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:done']);
  });
});

describe('sub-issues as declared parts', () => {
  function withSubIssues() {
    const s = setup();
    s.gh.createIssue({ repo: REPO, labels: ['hopper'], body: 'Ship it in two steps.' });
    s.gh.createIssue({ repo: REPO, parent: 1 });
    s.gh.createIssue({ repo: REPO, parent: 1 });
    return s;
  }

  it('an issue with no checklist "Parts" declares its sub-issues: a closed sub-issue is a done part', async () => {
    const { gh, source } = withSubIssues();
    expect((await discoverOne(source)).parts).toEqual({ done: 0, total: 2 });
    gh.closeIssue(REPO, 2);
    const item = await discoverOne(source);
    expect(item.parts).toEqual({ done: 1, total: 2 });
    expect(item.prompt).toContain('parts: 1 of 2 done');
    expect(item.prompt).toContain('its sub-issues');
  });

  it('beside a checklist "Parts", each sub-issue no item names is a part too; one an item names counts once', async () => {
    const { gh, source } = withSubIssues();
    gh.editIssue(REPO, 1, { body: '## Parts\n- [x] one\n- [ ] #3 the fix' }, 'owner');
    expect((await discoverOne(source)).parts).toEqual({ done: 1, total: 3 });
    gh.closeIssue(REPO, 2);
    expect((await discoverOne(source)).parts).toEqual({ done: 2, total: 3 });
    gh.closeIssue(REPO, 3);
    expect((await discoverOne(source)).parts).toEqual({ done: 3, total: 3 });
  });

  it('beside a checklist, sub-issues that cannot be listed count as GitHub sums them up', async () => {
    const { gh, source } = withSubIssues();
    gh.editIssue(REPO, 1, { body: '## Parts\n- [x] one\n- [ ] #3 the fix' }, 'owner');
    gh.closeIssue(REPO, 2);
    gh.failNext('subIssues', new Error('gh: Service Unavailable (HTTP 503)'));
    expect((await discoverOne(source)).parts).toEqual({ done: 2, total: 4 });
  });

  it('a merged part leaves the issue to do while a sub-issue no checklist item names is open (a job\'s required child)', async () => {
    const { gh, source } = withSubIssues();
    gh.editIssue(REPO, 1, { body: '## Parts\n- [ ] one\n- [ ] #3 the fix' }, 'owner');
    gh.closeIssue(REPO, 3);
    const pr = gh.openPartPullRequest(REPO, 1, { createdAt: AFTER });
    gh.mergePullRequest(pr.url);
    const job = jobForIssue(1, { status: 'finished', partlyDone: pr.url, sourceState: { source: { pullRequest: pr.url, follow: 'open', part: true } } });
    expect(await source.follow!(job)).toMatchObject({ outcome: 'merged', part: true, state: { parts: { done: 2, total: 3 } } });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
  });

  it('a merged part makes the issue done only when every sub-issue is closed', async () => {
    const { gh, source } = withSubIssues();
    gh.closeIssue(REPO, 2);
    gh.closeIssue(REPO, 3);
    const pr = gh.openPartPullRequest(REPO, 1, { createdAt: AFTER });
    gh.mergePullRequest(pr.url);
    const job = jobForIssue(1, { status: 'finished', partlyDone: pr.url, sourceState: { source: { pullRequest: pr.url, follow: 'open', part: true } } });
    expect(await source.follow!(job)).toMatchObject({ outcome: 'merged', part: true, state: { parts: { done: 2, total: 2 } } });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:done']);
  });

  it('every part done: the prompt says to check the issue and close it when nothing is left', async () => {
    const { gh, source } = withSubIssues();
    gh.closeIssue(REPO, 2);
    gh.closeIssue(REPO, 3);
    expect((await discoverOne(source)).prompt).toContain('every part is done');
  });
});

describe('the REST issue', () => {
  const rest = { number: 1, title: 't', state: 'open', html_url: 'u', updated_at: 'now' };
  it('carries its sub-issues, how many and how many closed (sub_issues_summary); none when it has none', () => {
    expect(issueFrom({ ...rest, sub_issues_summary: { total: 3, completed: 1, percent_completed: 33 } }, REPO).subIssues).toEqual({ total: 3, closed: 1 });
    expect(issueFrom({ ...rest, sub_issues_summary: { total: 0, completed: 0, percent_completed: 0 } }, REPO).subIssues).toBeUndefined();
    expect(issueFrom(rest, REPO).subIssues).toBeUndefined();
  });

  it('a sub-issue, as GitHub lists it: its repository from its repository_url, its number and state', () => {
    expect(subIssueFrom({ ...rest, state: 'closed', repository_url: 'https://api.github.com/repos/other/repo' }, REPO)).toEqual({ repo: 'other/repo', number: 1, state: 'closed' });
    expect(subIssueFrom(rest, REPO)).toEqual({ repo: REPO, number: 1, state: 'open' });
  });
});
