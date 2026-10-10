// Issue #673: a job shares its artifact with the owner — the person whose job it is. The owner sees it already, so the
// share is a no-op that succeeds; what it does is show the artifact: its link is posted on the job's issue (through the
// GitHub proxy, as the job's own comment, under the publishing rule) and the job's timeline says so. An issue whose
// deliverable is an artifact is then done, with no pull request. The real daemon, a joined machine, the real
// `hopper-artifact`; GitHub is the fake on loopback.
//
// Feature: share with the owner
//   Scenario: `share ID --owner` succeeds and posts the artifact's link on the issue
//     Given a job of issue octo-org/hello#7 that put an artifact, and the hopper's GitHub connected
//     When the job runs `share ID --owner`
//     Then it exits 0, the issue has a comment naming the artifact, and `artifact.posted` is on the job's timeline
//     And the comment names no machine: with no public URL it gives the artifact's id, not a local address
//   Scenario: `share ID --user <the owner's name>` is the same no-op success
//   Scenario: with a public URL the comment links the artifact through it
//   Scenario: an artifact-only issue is done once the link is on it, with no pull request
import { afterEach, describe, expect, it } from 'vitest';
import type { ArtifactView } from '../../src/domain/types.ts';
import { createAccountGitHubApi } from '../../src/sources/github/account/api.ts';
import { notComplete } from '../../src/sources/github/completion.ts';
import { artifactHarness, eventsOf, ISSUE } from '../support/artifacts.ts';
import { createFakeGitHub, type FakeForge } from '../support/fake-forges.ts';
import { connectGitHub } from '../support/github-account.ts';

const h = artifactHarness();
const forges: FakeForge[] = [];
afterEach(async () => {
  await h.stop();
  for (const f of forges.splice(0)) await f.close();
});

async function withGitHub(o: { env?: Record<string, string>; body?: string } = {}) {
  const github = await createFakeGitHub({
    clientId: 'gh-client-id',
    issues: [{ repo: ISSUE.repo, number: ISSUE.number, title: 'A chart', body: o.body ?? 'Make a chart.', author: 'owner', labels: ['hopper'] }],
  });
  forges.push(github);
  github.tokens.set('test-account-token', 'owner');
  const booted = await h.boot({ env: { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test', ...o.env } });
  connectGitHub(booted.a, [ISSUE.repo]);
  const { dir } = h.file('chart.html', '<!doctype html><p>42</p>\n');
  const art = (JSON.parse((await h.artifact(booted.a, booted.job, ['put', 'chart.html', '--title', 'Queue wait', '--json'], { cwd: dir })).stdout) as { artifact: ArtifactView }).artifact;
  return { ...booted, github, art };
}

const commentsOf = (github: FakeForge): string[] =>
  (github.issues.find((i) => i.repo === ISSUE.repo && i.number === ISSUE.number)?.comments ?? []).map((c) => String(c.body));

describe('share with the owner (issue #673)', () => {
  it('`share ID --owner` succeeds, posts the artifact on the issue, and the job\'s timeline says so', async () => {
    const { a, job, github, art } = await withGitHub();
    const shared = await h.artifact(a, job, ['share', art.id, '--owner', '--json']);
    expect(shared.code).toBe(0);
    const out = JSON.parse(shared.stdout) as { ok: boolean; owner: boolean; url: string; posted: string };
    expect(out).toMatchObject({ ok: true, owner: true, url: `${a.url}/#artifacts/${art.id}` });
    expect(out.posted).toMatch(/\/octo-org\/hello\/issues\/7#issuecomment-\d+$/);

    const [comment] = commentsOf(github);
    expect(comment).toContain(art.id);
    expect(comment).toContain('Queue wait');
    // The publishing rule: no local address, host or port on GitHub.
    expect(comment).not.toContain('127.0.0.1');
    expect(comment).not.toContain(new URL(a.url).port);
    expect(eventsOf(a, 'artifact.posted')).toEqual([expect.objectContaining({ jobId: job, data: expect.objectContaining({ artifact: art.id, by: `job ${job}`, comment: out.posted }) })]);
    expect(eventsOf(a, 'artifact.shared')).toEqual([]);
    expect(a.user().store.artifacts.shares(art.id)).toEqual([]);
  });

  it('`share ID --user <the owner>` is the same no-op success', async () => {
    const { a, job, github, art } = await withGitHub();
    const shared = await h.artifact(a, job, ['share', art.id, '--user', a.user().user.name]);
    expect(shared.code).toBe(0);
    expect(shared.stdout).toMatch(/^shown: .*the owner sees it already/m);
    expect(shared.stdout).toMatch(/^posted: \S+issuecomment-\d+$/m);
    expect(commentsOf(github)).toHaveLength(1);
  });

  it('with a public URL the comment links the artifact through it', async () => {
    const { a, job, github, art } = await withGitHub({ env: { HOPPER_PUBLIC_URL: 'https://hopper.example.com' } });
    expect((await h.artifact(a, job, ['share', art.id, '--owner'])).code).toBe(0);
    expect(commentsOf(github)[0]).toContain(`https://hopper.example.com/#artifacts/${art.id}`);
  });

  it('an artifact-only issue is done once the link is on it, with no pull request', async () => {
    const { a, job, github, art } = await withGitHub({ body: 'Make a chart.\n\nDeliverable: artifact\n' });
    const api = createAccountGitHubApi({ apiUrl: `${github.url}/api/v3`, token: async () => 'test-account-token' });
    const theJob = a.user().store.jobs.get(job)!;
    const artifactsOf = () => a.user().store.artifacts.list({ jobId: job }).map((x) => ({ id: x.id, ...(x.issue ? { issue: x.issue.url } : {}) }));
    expect(await notComplete(api, theJob, artifactsOf)).toMatch(/no comment on it names the job's artifact/);
    expect((await h.artifact(a, job, ['share', art.id, '--owner'])).code).toBe(0);
    expect(await notComplete(api, theJob, artifactsOf)).toBeUndefined();
  });
});
