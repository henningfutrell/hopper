// The GitLab source (issue #1448, design.md "A GitLab source", "Jobs through GitLab"): the open issues labelled hopper in the
// projects picked for the user's GitLab account, read through its token, listed in Intake. An issue assigned to the account,
// of a trusted origin, with no end label, is a job's item (part 3); the hopper writes only its labels to GitLab. Over a fake
// GitLab on loopback; Access is a stand-in that trusts the actors it is told, as OpenFGA's `intake#can_start_jobs` does.
//
// Feature: the GitLab source
//   Scenario: an issue the account wrote, labelled and assigned to itself is a job's item: its prompt, its project, trusted
//   Scenario: an issue another person wrote, labelled, assigned or edited is a request card (issue #1642), with who did what
//   Scenario: an issue assigned to another person is not assigned to you; one with an end label or on the backburner is not taken
//   Scenario: with no Access, nobody is a trusted actor, so no issue is taken
//   Scenario: a report writes the hopper's labels: claimed, then hopper:pr-ready or the end label; a missing issue is a permanent error
//   Scenario: a project GitLab does not answer is named; the others are still listed; none answering is the source's error
//   Scenario: paused with no account, and with no project picked
//   Scenario: GitLab refusing the token ends only the account: the source stops reading, pauses, and lists nothing
import { afterEach, describe, expect, it } from 'vitest';
import { createGitLabAccount } from '../../src/gitlab/account.ts';
import { createGitLabSource } from '../../src/gitlab/source.ts';
import { REQUEST_REASON } from '../../src/sources/github/origin.ts';
import type { GitLabAccountRecord } from '../../src/domain/gitlab-account.ts';
import type { GitLabActorRef } from '../../src/domain/access.ts';
import type { Job } from '../../src/domain/types.ts';
import { createFakeGitLab, type FakeGitLabIssue } from '../support/fake-gitlab.ts';
import { memoryAccountStore, systemOf } from '../support/system-secrets.ts';

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

/** Access as OpenFGA answers `intake#can_start_jobs`: the actor is one of the trusted actors told. */
const access = async (actor: GitLabActorRef, actors: readonly GitLabActorRef[]) => ({ allowed: actors.some((a) => a.baseUrl === actor.baseUrl && a.userId === actor.userId), reason: '' });

const ISSUES: FakeGitLabIssue[] = [
  { project: 'ada/tools', iid: 1, title: 'Fix the parser', description: 'It drops the last line.', author: 'ada', assignees: ['ada'], labels: ['hopper', 'hopper:high'] },
  { project: 'ada/tools', iid: 2, title: 'Someone else\'s', author: 'bob', assignees: ['bob'], labels: ['hopper', 'bug'] },
  { project: 'ada/tools', iid: 3, title: 'No label', author: 'ada', assignees: ['ada'], labels: [] },
  { project: 'ada/tools', iid: 4, title: 'Closed', author: 'ada', assignees: ['ada'], labels: ['hopper'], state: 'closed' },
  { project: 'acme/platform/api', iid: 9, title: 'Deep', description: 'Rename it.', author: 'ada', assignees: ['Ada'], labels: ['hopper'] },
];

async function setup(o: { issues?: FakeGitLabIssue[]; access?: boolean } = {}) {
  const gitlab = await createFakeGitLab({ issues: structuredClone(o.issues ?? ISSUES) });
  cleanups.push(() => gitlab.close());
  gitlab.perPage = 1; // every list is paged
  gitlab.tokens.set('glpat-ada', { id: 7, username: 'ada', email: 'ada@example.com', projects: ['ada/tools', 'acme/platform/api'] });
  gitlab.ids.set('bob', 8);
  gitlab.defaultBranches.set('acme/platform/api', 'trunk');
  let kept: GitLabAccountRecord | undefined;
  const account = createGitLabAccount({
    settings: { getGitLabAccount: () => (kept ? structuredClone(kept) : undefined), setGitLabAccount: (r) => { kept = r ?? undefined; } },
    secrets: systemOf(memoryAccountStore().store), clock: { now: () => new Date() }, logger: { info: () => undefined, warn: () => undefined },
    ...(o.access === false ? {} : { startsJobs: access }),
  });
  const source = createGitLabSource({ name: 'gitlab-account', account, executor: 'herdr-claude' });
  return { gitlab, account, source };
}

async function connected(o: Parameters<typeof setup>[0] = {}) {
  const s = await setup(o);
  await s.account.connect({ token: 'glpat-ada', baseUrl: s.gitlab.url });
  s.account.choose(['ada/tools', 'acme/platform/api']);
  return s;
}

const jobOf = (project: string, iid: number): Job => ({ id: 'j1', source: { source: 'gitlab-account', kind: 'gitlab-account', key: `https://gitlab.test/${project}/-/issues/${iid}`, url: 'u', title: 't', author: 'ada', repo: project, number: iid, labels: [] } } as unknown as Job);

describe('the GitLab source', () => {
  it('takes an issue the account wrote, labelled and assigned to itself, as a job\'s item', async () => {
    const s = await connected();
    const items = await s.source.discover();
    expect(items.map((i) => i.key)).toEqual([`${s.gitlab.url}/ada/tools/-/issues/1`, `${s.gitlab.url}/acme/platform/api/-/issues/9`]);
    const [fix, deep] = items;
    expect(fix).toMatchObject({
      url: `${s.gitlab.url}/ada/tools/-/issues/1`, title: 'Fix the parser', body: 'It drops the last line.', author: 'ada', assignee: 'ada',
      repo: 'ada/tools', number: 1, labels: ['hopper', 'hopper:high'], priority: 75, priorityReason: 'label:hopper:high', executor: 'herdr-claude', origin: 'trusted',
      env: { HOPPER_ISSUE_URL: `${s.gitlab.url}/ada/tools/-/issues/1`, HOPPER_REPO: 'ada/tools', HOPPER_ISSUE_NUMBER: '1', HOPPER_ISSUE_TITLE: 'Fix the parser' },
    });
    expect(fix!.prompt).toContain('<<<hopper-untrusted-issue-text');
    expect(fix!.prompt).toContain('It drops the last line.');
    expect(fix!.prompt).toContain(`forge: GitLab · project: ada/tools · issue: #1`);
    expect(fix!.prompt).toContain(`git push to ${s.gitlab.url} go through the hopper`);
    expect(fix!.prompt).toContain('git push -o merge_request.create -o merge_request.target=main -o merge_request.title="Fix the parser" -o "merge_request.description=Closes #1" origin HEAD:<your branch>');
    expect(deep!.prompt).toContain('-o merge_request.target=trunk');
    expect(deep).toMatchObject({ priority: 50, priorityReason: 'default' });
    expect(s.source.intake!()).toEqual([
      { key: `${s.gitlab.url}/ada/tools/-/issues/1`, title: 'Fix the parser', repo: 'ada/tools' },
      { key: `${s.gitlab.url}/ada/tools/-/issues/2`, title: 'Someone else\'s', repo: 'ada/tools', reason: expect.stringContaining('not assigned to your GitLab account ada'), group: 'not-assigned' },
      { key: `${s.gitlab.url}/acme/platform/api/-/issues/9`, title: 'Deep', repo: 'acme/platform/api' },
    ]);
    expect(s.source.describe()).toMatchObject({ login: 'ada', baseUrl: s.gitlab.url, projects: ['ada/tools', 'acme/platform/api'], label: 'hopper', issues: 3 });
    expect(s.gitlab.requests.every((r) => r.token === 'glpat-ada' && r.method === undefined)).toBe(true); // a discover writes nothing
    expect(await s.source.check([])).toEqual([]);
  });

  it('does not take an issue another person wrote, labelled, assigned or edited, and says who did what', async () => {
    const mine = { project: 'ada/tools', assignees: ['ada'], labels: ['hopper'], author: 'ada', description: 'x' };
    const s = await connected({ issues: [
      { ...mine, iid: 1, title: 'Written by bob', author: 'bob', labelledBy: 'ada', assignedBy: 'ada' },
      { ...mine, iid: 2, title: 'Labelled by bob', labelledBy: 'bob' },
      { ...mine, iid: 3, title: 'Assigned by bob', assignedBy: 'bob' },
      { ...mine, iid: 4, title: 'Edited by bob', editedBy: ['bob'] },
      { ...mine, iid: 5, title: 'Edited by ada', editedBy: ['ada'] },
    ] });
    expect((await s.source.discover()).map((i) => i.title)).toEqual(['Edited by ada']);
    expect(s.source.intake!().filter((x) => x.reason !== undefined).every((x) => x.reason === REQUEST_REASON && x.group === 'request' && x.action === 'approve')).toBe(true);
    const why = Object.fromEntries(s.source.intake!().map((x) => [x.title, x.request?.why]));
    expect(why).toEqual({
      'Written by bob': ['bob wrote it, and is not a trusted actor'],
      'Labelled by bob': ['bob added the label, and is not a trusted actor'],
      'Assigned by bob': ['bob assigned it, and is not a trusted actor'],
      'Edited by bob': ['bob edited its title or description, and is not a trusted actor'],
      'Edited by ada': undefined,
    });
  });

  it('does not take an issue with an end label or on the backburner', async () => {
    const mine = { project: 'ada/tools', assignees: ['ada'], author: 'ada', description: 'x' };
    const s = await connected({ issues: [
      { ...mine, iid: 1, title: 'Done', labels: ['hopper', 'hopper:done'] },
      { ...mine, iid: 2, title: 'Failed', labels: ['hopper', 'hopper:failed'] },
      { ...mine, iid: 3, title: 'Later', labels: ['hopper', 'hopper:backburner'] },
    ] });
    expect(await s.source.discover()).toEqual([]);
    expect(s.source.intake!().map((x) => [x.title, x.group, x.reason])).toEqual([
      ['Done', 'other', 'labelled hopper:done: remove the label at GitLab to offer it again'],
      ['Failed', 'other', 'labelled hopper:failed: remove the label at GitLab to offer it again'],
      ['Later', 'backburner', 'on the backburner (hopper:backburner)'],
    ]);
  });

  it('takes no issue with no Access: nobody is a trusted actor', async () => {
    const s = await connected({ access: false });
    expect(await s.source.discover()).toEqual([]);
    expect(s.source.intake!().find((x) => x.title === 'Fix the parser')?.request?.why).toEqual(['ada wrote it, and is not a trusted actor', 'ada added the label, and is not a trusted actor', 'ada assigned it, and is not a trusted actor']);
  });

  it('writes the hopper\'s labels as a job is claimed and ends', async () => {
    const s = await connected();
    const issue = () => s.gitlab.issues.find((i) => i.iid === 1)!;
    await s.source.report({ kind: 'claimed', job: jobOf('ada/tools', 1) });
    expect(issue().labels).toEqual(['hopper', 'hopper:high', 'hopper:claimed']);
    await s.source.report({ kind: 'claimed', job: jobOf('ada/tools', 1) }); // again: nothing more
    expect(issue().labels).toEqual(['hopper', 'hopper:high', 'hopper:claimed']);
    // Open, its merge request not found yet: it waits for review, and the follow looks for it (follow.test.ts).
    expect(await s.source.report({ kind: 'finished', job: jobOf('ada/tools', 1) })).toEqual({ reported: 'finished', follow: 'open' });
    expect(issue().labels).toEqual(['hopper', 'hopper:high', 'hopper:pr-ready']);
    await s.source.report({ kind: 'failed', job: jobOf('acme/platform/api', 9) });
    expect(s.gitlab.issues.find((i) => i.iid === 9)!.labels).toEqual(['hopper', 'hopper:failed']);
    expect(s.gitlab.requests.filter((r) => r.method === 'PUT').slice(-2)).toMatchObject([
      { path: '/api/v4/projects/acme%2Fplatform%2Fapi/issues/9', body: { remove_labels: 'hopper:claimed' } },
      { path: '/api/v4/projects/acme%2Fplatform%2Fapi/issues/9', body: { add_labels: 'hopper:failed' } },
    ]);
    // An issue GitLab does not find fails its row for good (issue #1892 part 17), not the report: a person's Retry sends it again.
    await s.source.report({ kind: 'claimed', job: jobOf('ada/tools', 77) });
    expect(s.source.describe().outboxFailed).toEqual([expect.objectContaining({ act: 'report', repo: 'ada/tools', error: expect.stringContaining('404') })]);
  });

  it('names a project GitLab does not answer and lists the others; none answering is the source\'s error', async () => {
    const s = await connected();
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
    const s = await connected();
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
