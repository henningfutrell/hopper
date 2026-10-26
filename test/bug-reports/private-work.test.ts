// A job's report keeps nothing of its private work (issue #2812): the repositories it worked in, their numbers, branches,
// paths and commits, links off the hopper's repository, long ids and names from the owner's environment are removed
// before the report is sent; what is the hopper's own stays. Pure.
import { describe, expect, it } from 'vitest';
import { commitCandidates, privateWorkOfEvents, scrubPrivateWork, type HopperOwn, type PrivateWork } from '../../src/bug-reports/index.ts';

const WORK: PrivateWork = {
  repos: ['acme/infra-live'], numbers: [412, 87], branches: ['fix-db-timeouts'],
  dirs: ['/srv/work/acme-infra'], names: ['buildbox-7', 'prod-east'],
};
const OWN: HopperOwn = { isPath: (p) => p === 'src/bug-reports/service.ts' || p === 'docs/design.md', commits: new Set(['9393b4962']) };
const scrub = (text: string, work: PrivateWork = WORK) => scrubPrivateWork(text, work, OWN);

describe('the scrub of a job\'s private work', () => {
  it('removes the repository, its numbers, the branch, its paths and its commit ids', () => {
    const r = scrub([
      'Working on acme/infra-live#412 (PR #87) on branch fix-db-timeouts.',
      'The push of 5f3e9a1c2b went through, but modules/rds/main.tf:12 was not in /srv/work/acme-infra/modules/rds.',
      'infra-live has a ruleset; acme/other#3 too.',
    ].join('\n'));
    for (const leak of ['acme', 'infra-live', '412', '#87', 'fix-db-timeouts', '5f3e9a1c2b', 'modules/rds', '/srv/work', 'other#3']) expect(r.text).not.toContain(leak);
    expect(r.text).toContain('Working on [a repository]');
    expect(r.removed).toEqual(expect.arrayContaining(['repository', 'issue or pull request number', 'branch name', 'file path', 'commit id']));
  });

  it('removes links off the hopper\'s repository, and keeps the hopper\'s own', () => {
    const r = scrub('See https://github.com/acme/infra-live/actions/runs/123 and https://grafana.acme.example/d/x, like https://github.com/henningfutrell/hopper/issues/2813.');
    expect(r.text).toBe('See [a link] and [a link], like https://github.com/henningfutrell/hopper/issues/2813.');
    expect(r.removed).toEqual(['link']);
  });

  it('removes run and account ids, uuids, cloud resource names and the environment\'s names', () => {
    const r = scrub('Run 18234567890 on buildbox-7 for account 123456789012, job 89d05e6b-65de-4384-b729-a11bd4893517, role arn:aws:iam::123:role/deploy in prod-east.');
    expect(r.text).toBe('Run [an id] on [a name] for account [an id], job [an id], role [a name] in [a name].');
    expect(r.removed).toEqual(['environment name', 'long id']);
  });

  it('keeps the hopper\'s own paths, commits, issue numbers and plain words', () => {
    const text = 'In src/bug-reports/service.ts:120 (see docs/design.md, henningfutrell/hopper#2813 and #1591, commit 9393b4962) the read/write path of POST /job/github fails at v1.2.3 on 2026-10-26.';
    expect(scrub(text)).toEqual({ text, removed: [] });
  });

  it('removes any path that is not the hopper\'s, and a repository of the job\'s owner', () => {
    const r = scrub('It read ./deploy/values.yaml and ~/notes.txt, then acme/charts.');
    expect(r.text).toBe('It read [a file path] and [a file path], then [a repository].');
  });

  it('removes nothing when the job worked in the hopper\'s repository alone', () => {
    const r = scrub('Fails on #2813 in henningfutrell/hopper.', { repos: ['henningfutrell/hopper'], numbers: [], branches: [], dirs: [], names: [] });
    expect(r).toEqual({ text: 'Fails on #2813 in henningfutrell/hopper.', removed: [] });
  });
});

describe('the private work of a job\'s proxy events', () => {
  it('is the repositories, numbers and branches it named, not the hopper\'s', () => {
    expect(privateWorkOfEvents([
      { type: 'github_proxy.done', data: { op: 'pr.create', repo: 'acme/infra-live', number: 87, url: 'u' } },
      { type: 'github_proxy.done', data: { op: 'git.push', repo: 'acme/infra-live', refs: ['refs/heads/fix-db-timeouts'] } },
      { type: 'github_proxy.done', data: { op: 'repo.fork', repo: 'other/lib', url: 'u', fork: 'acme/lib' } },
      { type: 'github_proxy.done', data: { op: 'issue.view', repo: 'henningfutrell/hopper', number: 2813, url: 'u' } },
      { type: 'job.started', data: { repo: 'x/y' } },
    ])).toEqual({ repos: ['acme/infra-live', 'other/lib', 'acme/lib'], numbers: [87], branches: ['fix-db-timeouts'] });
  });

  it('asks about commit ids only: hex with a digit and a letter', () => {
    expect(commitCandidates('commit 9393B4962, deadbeef, 12345678 and abc1234')).toEqual(['9393b4962', 'abc1234']);
  });
});
