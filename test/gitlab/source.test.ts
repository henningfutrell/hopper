// The GitLab source (issue #1448 part 2, design.md "A GitLab source"): the open issues labelled hopper in the projects picked
// for the user's GitLab account, read through its token, listed in Intake with why each is not taken; no job is taken from
// GitLab yet, and nothing is written to GitLab. Over a fake GitLab on loopback.
//
// Feature: the GitLab source
//   Scenario: Intake lists each labelled open issue of the picked projects; an issue assigned to another person is not assigned to you
//   Scenario: a project GitLab does not answer is named; the others are still listed; none answering is the source's error
//   Scenario: paused with no account, and with no project picked
//   Scenario: GitLab refusing the token ends only the account: the source stops reading, pauses, and lists nothing
import { afterEach, describe, expect, it } from 'vitest';
import { createGitLabAccount } from '../../src/gitlab/account.ts';
import { createGitLabSource, NOT_TAKEN_YET } from '../../src/gitlab/source.ts';
import type { GitLabAccountRecord } from '../../src/domain/gitlab-account.ts';
import { createFakeGitLab } from '../support/fake-gitlab.ts';
import { memoryAccountStore, systemOf } from '../support/system-secrets.ts';

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

async function setup() {
  const gitlab = await createFakeGitLab({
    issues: [
      { project: 'ada/tools', iid: 1, title: 'Mine', author: 'ada', assignees: ['ada'], labels: ['hopper'] },
      { project: 'ada/tools', iid: 2, title: 'Someone else\'s', author: 'bob', assignees: ['bob'], labels: ['hopper', 'bug'] },
      { project: 'ada/tools', iid: 3, title: 'No label', author: 'ada', assignees: ['ada'], labels: [] },
      { project: 'ada/tools', iid: 4, title: 'Closed', author: 'ada', assignees: ['ada'], labels: ['hopper'], state: 'closed' },
      { project: 'acme/platform/api', iid: 9, title: 'Deep', author: 'ada', assignees: ['Ada'], labels: ['hopper'] },
    ],
  });
  cleanups.push(() => gitlab.close());
  gitlab.perPage = 1; // every list is paged
  gitlab.tokens.set('glpat-ada', { id: 7, username: 'ada', email: 'ada@example.com', projects: ['ada/tools', 'acme/platform/api'] });
  let kept: GitLabAccountRecord | undefined;
  const account = createGitLabAccount({
    settings: { getGitLabAccount: () => (kept ? structuredClone(kept) : undefined), setGitLabAccount: (r) => { kept = r ?? undefined; } },
    secrets: systemOf(memoryAccountStore().store), clock: { now: () => new Date() }, logger: { info: () => undefined, warn: () => undefined },
  });
  const source = createGitLabSource({ name: 'gitlab-account', account });
  return { gitlab, account, source };
}

describe('the GitLab source', () => {
  it('lists each labelled open issue of the picked projects in Intake, and takes no job', async () => {
    const s = await setup();
    await s.account.connect({ token: 'glpat-ada', baseUrl: s.gitlab.url });
    s.account.choose(['ada/tools', 'acme/platform/api']);
    expect(await s.source.discover()).toEqual([]);
    expect(s.source.intake!()).toEqual([
      { key: `${s.gitlab.url}/ada/tools/-/issues/1`, title: 'Mine', repo: 'ada/tools', reason: NOT_TAKEN_YET, group: 'other' },
      { key: `${s.gitlab.url}/ada/tools/-/issues/2`, title: 'Someone else\'s', repo: 'ada/tools', reason: expect.stringContaining('not assigned to your GitLab account ada'), group: 'not-assigned' },
      { key: `${s.gitlab.url}/acme/platform/api/-/issues/9`, title: 'Deep', repo: 'acme/platform/api', reason: NOT_TAKEN_YET, group: 'other' },
    ]);
    expect(s.source.describe()).toMatchObject({ login: 'ada', baseUrl: s.gitlab.url, projects: ['ada/tools', 'acme/platform/api'], label: 'hopper', issues: 3 });
    expect(s.gitlab.requests.some((r) => r.path.includes('/projects/acme%2Fplatform%2Fapi/issues'))).toBe(true);
    expect(await s.source.check([])).toEqual([]);
  });

  it('names a project GitLab does not answer and lists the others; none answering is the source\'s error', async () => {
    const s = await setup();
    await s.account.connect({ token: 'glpat-ada', baseUrl: s.gitlab.url });
    s.account.choose(['ada/tools', 'acme/platform/api']);
    s.gitlab.failing.add('ada/tools');
    await s.source.discover();
    expect(s.source.intake!().map((x) => x.title)).toEqual(['Deep']);
    expect(s.source.describe()).toMatchObject({ repoErrors: { 'ada/tools': expect.stringContaining('500') } });
    s.gitlab.failing.add('acme/platform/api');
    await expect(s.source.discover()).rejects.toThrow('GitLab answered no project');
  });

  it('is paused with no account, and with no project picked', async () => {
    const s = await setup();
    expect(s.source.paused!()).toContain('no GitLab account is connected');
    await s.account.connect({ token: 'glpat-ada', baseUrl: s.gitlab.url });
    expect(s.source.paused!()).toContain('no GitLab project is picked');
  });

  it('pauses when GitLab refuses the token, and lists nothing', async () => {
    const s = await setup();
    await s.account.connect({ token: 'glpat-ada', baseUrl: s.gitlab.url });
    s.account.choose(['ada/tools', 'acme/platform/api']);
    await s.source.discover();
    s.gitlab.refused.add('glpat-ada');
    const asked = s.gitlab.requests.length;
    expect(await s.source.discover()).toEqual([]);
    expect(s.gitlab.requests.slice(asked).map((r) => r.path)).toEqual([expect.stringContaining('/projects/ada%2Ftools/issues')]); // the rest would be refused too
    expect(s.source.paused!()).toContain('GitLab refused the token of ada');
    await s.source.discover();
    expect(s.source.intake!()).toEqual([]);
  });
});
