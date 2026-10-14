// Issue #673: an issue whose deliverable is an artifact, not a code change. Its body says so on a line of its own
// ("Deliverable: artifact"); the job is done when it made at least one artifact linked to the issue and the issue has a
// comment that names it (its link, or its id) — no pull request. Every other issue still needs one (issue #637).
//
// Feature: artifact-only jobs are done
//   Scenario: an artifact-only issue finishes without a pull request, and the link is on the issue
//   Scenario: no artifact linked to the issue, or no comment naming one: not done, and the reason says which
//   Scenario: an issue without the line still needs its pull request, artifact or not
//   Scenario: the job is told what done means for it: put the artifact, then share it with its owner
import { describe, expect, it } from 'vitest';
import { isArtifactDeliverable } from '../../src/sources/github/completion.ts';
import { REPO, discoverOne, jobForIssue, setup } from './fixtures/github-support.ts';

const ART = '0722a67b-8c7c-4315-8582-8794aa7b9dbc';
const ISSUE_URL = `https://github.com/${REPO}/issues/1`;
const DELIVERABLE = 'Make a chart of queue wait by hour.\n\nDeliverable: artifact\n';

function withIssue(body: string, artifacts: { id: string; issue?: string }[]) {
  const s = setup({}, { jobArtifacts: () => artifacts });
  const issue = s.gh.createIssue({ repo: REPO, labels: ['hopper'], body });
  return { ...s, issue, job: jobForIssue(issue.number) };
}

describe('artifact-only jobs are done (issue #673)', () => {
  it('reads the line: "Deliverable: artifact" on a line of its own, any case; not inside a sentence', () => {
    expect(isArtifactDeliverable({ body: DELIVERABLE })).toBe(true);
    expect(isArtifactDeliverable({ body: 'x\n  deliverable:   Artifact  \ny' })).toBe(true);
    expect(isArtifactDeliverable({ body: 'The deliverable: artifact or code.' })).toBe(false);
    expect(isArtifactDeliverable({ body: 'Fix the bug.' })).toBe(false);
  });

  it('an artifact linked to the issue, and a comment naming it: done, with no pull request', async () => {
    const { gh, source, job } = withIssue(DELIVERABLE, [{ id: ART, issue: ISSUE_URL }]);
    gh.addComment(REPO, 1, 'owner', `The chart is on the hopper: artifact \`${ART}\`.`);
    expect(await source.notComplete!(job)).toBeUndefined();
  });

  it('a comment with the artifact\'s link counts too', async () => {
    const { gh, source, job } = withIssue(DELIVERABLE, [{ id: ART, issue: ISSUE_URL }]);
    gh.addComment(REPO, 1, 'owner', `[Queue wait](https://hopper.example.com/#artifacts/${ART})`);
    expect(await source.notComplete!(job)).toBeUndefined();
  });

  it('no artifact linked to the issue: not done, and the reason says so', async () => {
    const { gh, source, job } = withIssue(DELIVERABLE, [{ id: ART, issue: 'https://github.com/owner/other/issues/9' }]);
    gh.addComment(REPO, 1, 'owner', ART);
    expect(await source.notComplete!(job)).toMatch(/asks for an artifact, and the job made none linked to it/);
  });

  it('an artifact, but no comment on the issue names it: not done, and the reason names the artifact', async () => {
    const { gh, source, job } = withIssue(DELIVERABLE, [{ id: ART, issue: ISSUE_URL }]);
    gh.addComment(REPO, 1, 'owner', 'Working on it.');
    const why = await source.notComplete!(job);
    expect(why).toMatch(/no comment on it names the job's artifact/);
    expect(why).toContain(ART);
    expect(why).toMatch(/share ID --owner/);
  });

  it('an issue without the line still needs its pull request, whatever artifacts there are', async () => {
    const { gh, source, job } = withIssue('Fix the bug.', [{ id: ART, issue: ISSUE_URL }]);
    gh.addComment(REPO, 1, 'owner', ART);
    expect(await source.notComplete!(job)).toMatch(/no pull request in owner\/sandbox closes or references it/);
  });

  it('a pull request still makes an artifact-only issue done', async () => {
    const { gh, source, job } = withIssue(DELIVERABLE, []);
    gh.openPullRequest(REPO, 1, { createdAt: '2026-10-02T11:00:00.000Z' });
    expect(await source.notComplete!(job)).toBeUndefined();
  });

  it('the job is told what done means for it: put the artifact, share it with its owner, no pull request', async () => {
    const { gh, source } = setup({}, { jobArtifacts: () => [] });
    gh.createIssue({ repo: REPO, labels: ['hopper'], body: DELIVERABLE });
    const done = (await discoverOne(source)).prompt.split('\n').find((l) => l.startsWith('done'))!;
    expect(done).toMatch(/^done: this issue's deliverable is an artifact, not a code change/);
    expect(done).toContain('sh "$HOPPER_ARTIFACT" put FILE');
    expect(done).toContain('sh "$HOPPER_ARTIFACT" share ID --owner');
    expect(done).toMatch(/No pull request is needed/);
  });
});
