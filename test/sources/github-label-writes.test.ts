// Label writes that change nothing are not sent (issue #1154): a sync pass of a `github-account` source made up to 84 label
// calls, most of them a remove of a label the issue did not carry (a 404) or a create of a label the repository had. Where
// the hopper holds the issue's labels as just read, it removes only what the issue carries and adds only what it lacks;
// it creates only the labels it adds, once per repository per process.
import { describe, expect, it } from 'vitest';
import { REPO, jobForIssue, setup } from './fixtures/github-support.ts';

const AFTER = '2026-10-02T11:00:00.000Z';
const LABEL_WRITES = ['ensureLabel', 'addLabels', 'removeLabels'];

function withIssue(labels: string[] = ['hopper']) {
  const s = setup();
  s.gh.createIssue({ repo: REPO, labels });
  const writes = () => s.gh.calls.filter((c) => LABEL_WRITES.includes(c.method)).map((c) => [c.method, ...c.args]);
  return { ...s, writes };
}

describe('label writes that change nothing are not sent (issue #1154)', () => {
  it('claimed: creates only the label it adds, once per repository', async () => {
    const { gh, source, writes } = withIssue();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    await source.report({ kind: 'claimed', job: jobForIssue(1) });
    await source.report({ kind: 'claimed', job: jobForIssue(2) });
    expect(writes().filter(([m]) => m === 'ensureLabel').map(([, , name]) => name)).toEqual(['hopper:claimed']);
  });

  it('finished: removes only the labels the issue carries, adds pr-ready', async () => {
    const { gh, source, writes } = withIssue(['hopper', 'hopper:claimed']);
    gh.openPullRequest(REPO, 1, { createdAt: AFTER });
    await source.report({ kind: 'finished', job: jobForIssue(1, { status: 'finished' }) });
    expect(writes().filter(([m]) => m !== 'ensureLabel')).toEqual([
      ['removeLabels', REPO, 1, ['hopper:claimed']],
      ['addLabels', REPO, 1, ['hopper:pr-ready']],
    ]);
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:pr-ready']);
  });

  it('finished on an issue that already says pr-ready, with no claim: no label write at all', async () => {
    const { gh, source, writes } = withIssue(['hopper', 'hopper:pr-ready']);
    gh.openPullRequest(REPO, 1, { createdAt: AFTER });
    await source.report({ kind: 'finished', job: jobForIssue(1, { status: 'finished' }) });
    expect(writes()).toEqual([]);
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:pr-ready']);
  });

  it('run again: removes only the end and claim labels the issue carries; none carried, none removed', async () => {
    const { gh, source, writes } = withIssue(['hopper', 'hopper:failed']);
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    await source.rerun!(jobForIssue(1, { status: 'failed' }));
    await source.rerun!(jobForIssue(2, { status: 'failed' }));
    expect(writes()).toEqual([['removeLabels', REPO, 1, ['hopper:failed']]]);
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
  });

  it('the follow of a merged pull request: removes only what the issue carries', async () => {
    const { gh, source, writes } = withIssue();
    const pr = gh.openPullRequest(REPO, 1, { createdAt: AFTER });
    const base = jobForIssue(1, { status: 'finished' });
    const state = await source.report({ kind: 'finished', job: base });
    gh.mergePullRequest(pr.url);
    gh.calls.length = 0;
    await source.follow!({ ...base, sourceState: { source: state } });
    expect(writes().filter(([m]) => m !== 'ensureLabel')).toEqual([
      ['removeLabels', REPO, 1, ['hopper:pr-ready']],
      ['addLabels', REPO, 1, ['hopper:done']],
    ]);
    expect(gh.issue(REPO, 1)).toMatchObject({ state: 'closed', labels: ['hopper', 'hopper:done'] });
  });

  it('the follow of a closed pull request on an issue that says pr-closed already: no label write', async () => {
    const { gh, source, writes } = withIssue();
    const pr = gh.openPullRequest(REPO, 1, { createdAt: AFTER });
    const base = jobForIssue(1, { status: 'finished' });
    const state = await source.report({ kind: 'finished', job: base });
    gh.closePullRequest(pr.url);
    gh.removeLabel(REPO, 1, 'hopper:pr-ready');
    gh.addLabel(REPO, 1, 'hopper:pr-closed');
    gh.calls.length = 0;
    await source.follow!({ ...base, sourceState: { source: state } });
    expect(writes()).toEqual([]);
  });
});
