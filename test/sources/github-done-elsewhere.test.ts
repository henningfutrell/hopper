// A job's pull request in another repository (issue #2004): the job works in one repository, and its issue's change must
// land in another (infrastructure code that applies through its own CI). Its own pull request there, that closes, ships
// part of or references the issue by its full name, is the job's work: done, or a part; never "no pull request". A pull
// request of another repository the job did not open or push to never counts.
import { describe, expect, it } from 'vitest';
import { REPO, jobForIssue, setup } from './fixtures/github-support.ts';
import { judge } from '../../src/domain/pull-requests.ts';

const OTHER = 'owner/infra';
const BEFORE = '2026-10-01T09:00:00.000Z';
const AFTER = '2026-10-02T11:00:00.000Z';

function withIssue() {
  const s = setup();
  const issue = s.gh.createIssue({ repo: REPO, labels: ['hopper'] });
  return { ...s, issue, job: jobForIssue(issue.number) };
}

describe('the job\'s pull request in another repository (issue #2004)', () => {
  it('its own open pull request there that references the issue: done', async () => {
    const { gh, source, job } = withIssue();
    gh.mentionIssue(REPO, 1, { from: OTHER, text: `Refs ${REPO}#1`, closes: false, createdAt: AFTER });
    expect(await source.notComplete!(job)).toBeUndefined();
  });

  it('its own merged pull request there that references the issue by its URL: done', async () => {
    const { gh, source, job } = withIssue();
    const url = gh.mentionIssue(REPO, 1, { from: OTHER, text: `For https://github.com/${REPO}/issues/1`, closes: false, createdAt: AFTER });
    gh.mergePullRequest(url, AFTER);
    expect(await source.notComplete!(job)).toBeUndefined();
  });

  it('its own pull request there that says "Part of owner/repo#N": the job ends partly done, not handed to a person', async () => {
    const { gh, source, job } = withIssue();
    const url = gh.mentionIssue(REPO, 1, { from: OTHER, text: `Part of ${REPO}#1\n\nIt replaces an older one.`, closes: false, createdAt: AFTER });
    expect(await judge(source, job)).toEqual({ done: false, partlyDone: url });
  });

  it('its own pull request there with merge conflicts: the miss names it by its repository', async () => {
    const { gh, source, job } = withIssue();
    const url = gh.mentionIssue(REPO, 1, { from: OTHER, text: `Refs ${REPO}#1`, closes: false, createdAt: AFTER });
    gh.setConflicting(url, true);
    expect(await source.notComplete!(job)).toContain(`${OTHER}#${url.split('/').at(-1)} (open, merge conflicts)`);
  });

  it('a pull request there opened before the job, never pushed to by it: not the job\'s work', async () => {
    const { gh, source, job } = withIssue();
    gh.mentionIssue(REPO, 1, { from: OTHER, text: `Refs ${REPO}#1`, closes: false, createdAt: BEFORE });
    expect(await source.notComplete!(job)).toMatch(/no pull request in .* closes or references it$/);
    expect(await source.partlyDone!(job)).toBeUndefined();
  });

  it('"Part of #N" there names that repository\'s issue, not this one: no part', async () => {
    const { gh, source, job } = withIssue();
    gh.mentionIssue(REPO, 1, { from: OTHER, text: `Part of #1\n\nSee ${REPO}#1.`, closes: false, createdAt: AFTER });
    expect(await source.partlyDone!(job)).toBeUndefined();
  });
});
