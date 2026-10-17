// A job's pull request in another repository (issue #1778): a job of an issue in one repository may open its pull request
// in another. The follow reads, merges and moves that pull request in its own repository, from its URL, never as the pull
// request of the same number in the issue's repository; its yolo mode is that repository's.
import { describe, expect, it } from 'vitest';
import { REPO, jobForIssue, setup } from './fixtures/github-support.ts';

const INFRA = 'owner/infra';
const LONG_AGO = '2026-10-02T09:50:00.000Z';

function ended(pr: { conflicting?: boolean; base?: string }, yolo: (repo: string) => boolean = () => false) {
  const s = setup({}, { yoloMode: yolo });
  s.gh.createIssue({ repo: REPO, labels: ['hopper'] });
  const opened = s.gh.openUnlinkedPullRequest(INFRA, { createdAt: LONG_AGO, headRef: 'issue-1-change', body: `Closes ${REPO}#1`, ...pr });
  const job = jobForIssue(1, { status: 'finished', createdAt: '2026-10-02T09:00:00.000Z', sourceState: { source: { pullRequest: opened.url, follow: 'open' } } });
  return { ...s, pr: opened, job, number: Number(opened.url.slice(opened.url.lastIndexOf('/') + 1)) };
}

describe('a job\'s pull request in another repository (issue #1778)', () => {
  it('open with merge conflicts: what is seen is read from its own repository', async () => {
    const { gh, source, job, pr, number } = ended({ conflicting: true, base: 'master' });
    expect(await source.follow!(job)).toMatchObject({ outcome: 'open', pullRequest: pr.url, state: { seen: { conflicting: true, base: 'master' } } });
    expect(gh.calls.filter((c) => c.method === 'pullRequest').map((c) => c.args)).toContainEqual([INFRA, number]);
    expect(gh.calls.filter((c) => c.method === 'pullRequest').map((c) => c.args[0])).not.toContain(REPO);
  });

  it('ready, yolo mode on for its own repository: merged there', async () => {
    const { gh, source, job, number } = ended({}, (r) => r === INFRA);
    expect(await source.follow!(job)).toMatchObject({ outcome: 'merged', byHopper: true });
    expect(gh.calls.filter((c) => c.method === 'merge').map((c) => c.args)).toEqual([[INFRA, number]]);
  });

  it('ready, yolo mode on only for the issue\'s repository: not merged', async () => {
    const { gh, source, job } = ended({}, (r) => r === REPO);
    expect(await source.follow!(job)).toMatchObject({ outcome: 'open' });
    expect(gh.calls.filter((c) => c.method === 'merge')).toEqual([]);
  });
});
