import { describe, expect, it } from 'vitest';
import { GitHubApiError } from '../../src/sources/github/index.ts';
import { REPO, discoverOne, setup } from './fixtures/github-support.ts';

const url = (n: number) => `https://github.com/${REPO}/issues/${n}`;
const fieldProject = { [REPO]: { owner: 'owner', number: 3, mode: 'field', field: 'Priority', map: { P0: 100, P1: 75, P2: 50 } } };
const rankProject = { [REPO]: { owner: 'owner', number: 4, mode: 'rank' } };

describe('GitHub source priority', () => {
  it('labels: the highest matching priority label wins', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:p2', 'hopper:p0'] });
    expect(await discoverOne(source)).toMatchObject({ priority: 100, priorityReason: 'label:hopper:p0' });
  });

  it('no label and no project → defaultPriority', async () => {
    const { gh, source } = setup({ defaultPriority: 40 });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    expect(await discoverOne(source)).toMatchObject({ priority: 40, priorityReason: 'default' });
  });

  it('project field (single-select, mapped) wins over a label; the field name matches case-insensitively', async () => {
    const { gh, source } = setup({ projects: fieldProject });
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:p0'] });
    gh.setProjectItems('owner', 3, [{ url: url(1), fields: { priority: 'P1' } }]);
    expect(await discoverOne(source)).toMatchObject({ priority: 75, priorityReason: 'project:Priority=P1' });
    expect(gh.calls.find((c) => c.method === 'projectItems')?.args).toEqual(['owner', 3]);
  });

  it('a number field is used directly, clamped to 0..100', async () => {
    const { gh, source } = setup({ projects: fieldProject, repos: [REPO] });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    gh.setProjectItems('owner', 3, [{ url: url(1), fields: { priority: 62 } }, { url: url(2), fields: { priority: 250 } }]);
    const items = await source.discover();
    expect(items.map((i) => [i.priority, i.priorityReason])).toEqual([[62, 'project:Priority=62'], [100, 'project:Priority=250']]);
  });

  it('an unmapped option, a missing field or no project item falls back to labels', async () => {
    const { gh, source } = setup({ projects: fieldProject });
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:p3'] });
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:p1'] });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    gh.setProjectItems('owner', 3, [{ url: url(1), fields: { priority: 'Someday' } }, { url: url(2), fields: { status: 'Todo' } }]);
    const items = await source.discover();
    expect(items.map((i) => i.priorityReason)).toEqual(['label:hopper:p3', 'label:hopper:p1', 'default']);
  });

  it('rank: the top eligible item is 100, then 99…; ineligible items in the project do not count', async () => {
    const { gh, source } = setup({ projects: rankProject });
    gh.createIssue({ repo: REPO, labels: ['hopper'] }); // #1
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:done'] }); // #2 not eligible
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:p0'] }); // #3
    gh.setProjectItems('owner', 4, [
      { url: 'https://github.com/owner/elsewhere/issues/9' },
      { url: url(2) },
      { url: url(3) },
      { url: url(1) },
    ]);
    const items = await source.discover();
    const by = Object.fromEntries(items.map((i) => [i.number, [i.priority, i.priorityReason]]));
    expect(by).toEqual({ 3: [100, 'project:rank=1'], 1: [99, 'project:rank=2'] });
  });

  it('a project error falls back to labels and shows in status projectErrors; it clears once the project reads again', async () => {
    const { gh, source } = setup({ projects: fieldProject });
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:p1'] });
    gh.setProjectItems('owner', 3, new GitHubApiError('missing required scopes [read:project]', true));
    expect(await discoverOne(source)).toMatchObject({ priority: 75, priorityReason: 'label:hopper:p1' });
    expect(source.describe().projectErrors).toEqual({ [REPO]: 'missing required scopes [read:project]' });

    gh.setProjectItems('owner', 3, [{ url: url(1), fields: { priority: 'P0' } }]);
    expect(await discoverOne(source)).toMatchObject({ priority: 100, priorityReason: 'project:Priority=P0' });
    expect(source.describe().projectErrors).toEqual({});
  });

  it('re-sort: every discover recomputes priority from the current labels and project', async () => {
    const { gh, source } = setup({ projects: fieldProject });
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:p3'] });
    gh.setProjectItems('owner', 3, []);
    expect((await discoverOne(source)).priority).toBe(25);
    gh.addLabel(REPO, 1, 'hopper:p0');
    expect((await discoverOne(source)).priority).toBe(100);
    gh.setProjectItems('owner', 3, [{ url: url(1), fields: { priority: 'P2' } }]);
    expect((await discoverOne(source)).priority).toBe(50);
  });

  it('reads each project once per discover, however many issues it covers', async () => {
    const { gh, source } = setup({ projects: rankProject });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    gh.setProjectItems('owner', 4, [{ url: url(1) }, { url: url(2) }]);
    await source.discover();
    expect(gh.calls.filter((c) => c.method === 'projectItems')).toHaveLength(1);
  });

  it('repos without a project config never read a project', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    await source.discover();
    expect(gh.calls.some((c) => c.method === 'projectItems')).toBe(false);
  });
});
