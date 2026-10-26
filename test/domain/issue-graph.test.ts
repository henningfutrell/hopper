// The issue graph (issue #437): what one read of an issue gives as nodes and edges.
import { describe, expect, it } from 'vitest';
import { placeGraph, type IssuePlace } from '../../src/domain/issue-graph.ts';

const ISSUE = 'https://github.com/Acme/app/issues/7';
const place: IssuePlace = {
  issue: { repo: 'Acme/app', number: 7, url: ISSUE, title: 'Add a graph', state: 'open', updatedAt: '2026-10-11T10:00:00Z' },
  owner: { login: 'Acme', type: 'Organization' },
  projects: [{ owner: 'Acme', number: 3, url: 'https://github.com/orgs/Acme/projects/3', title: 'Roadmap' }],
  closedBy: [{ kind: 'pull_request', repo: 'Acme/app', number: 8, url: 'https://github.com/Acme/app/pull/8', state: 'open' }],
  references: [{ kind: 'issue', repo: 'other/lib', number: 2, url: 'https://github.com/other/lib/issues/2', state: 'closed' }],
  parent: { kind: 'issue', repo: 'Acme/app', number: 1, url: 'https://github.com/Acme/app/issues/1' },
  subIssues: [{ kind: 'issue', repo: 'Acme/app', number: 9, url: 'https://github.com/Acme/app/issues/9', state: 'open' }],
};

describe('placeGraph', () => {
  it('gives the issue, its repository, owner, Projects and linked items as nodes, each once', () => {
    const { nodes } = placeGraph(place);
    expect(nodes.map((n) => [n.kind, n.id]).sort()).toEqual([
      ['issue', 'https://github.com/Acme/app/issues/1'],
      ['issue', 'https://github.com/Acme/app/issues/7'],
      ['issue', 'https://github.com/Acme/app/issues/9'],
      ['issue', 'https://github.com/other/lib/issues/2'],
      ['owner', 'owner:acme'],
      ['owner', 'owner:other'],
      ['project', 'https://github.com/orgs/Acme/projects/3'],
      ['pull_request', 'https://github.com/Acme/app/pull/8'],
      ['repo', 'repo:acme/app'],
      ['repo', 'repo:other/lib'],
    ]);
    expect(nodes.find((n) => n.id === ISSUE)!.attrs).toEqual({ repo: 'Acme/app', number: 7, title: 'Add a graph', state: 'open', updatedAt: '2026-10-11T10:00:00Z' });
    expect(nodes.find((n) => n.id === 'owner:acme')!.attrs).toEqual({ login: 'Acme', type: 'Organization' });
    expect(nodes.find((n) => n.id === 'owner:other')!.attrs).toEqual({ login: 'other' });
  });

  it('keeps the issue\'s plan piece artifact (issue #2840) when the read says it, an empty one too, so a line taken away clears it', () => {
    const at = (artifact: string) => placeGraph({ ...place, issue: { ...place.issue, artifact } }).nodes.find((n) => n.id === ISSUE)!.attrs;
    expect(at('the report')).toMatchObject({ artifact: 'the report' });
    expect(at('')).toMatchObject({ artifact: '' });
  });

  it('links each to the issue by what ties them', () => {
    const { edges } = placeGraph(place);
    expect(edges.map((e) => `${e.from} ${e.kind} ${e.to}`).sort()).toEqual([
      'https://github.com/Acme/app/issues/1 in_repo repo:acme/app',
      `https://github.com/Acme/app/issues/7 in_project https://github.com/orgs/Acme/projects/3`,
      'https://github.com/Acme/app/issues/7 in_repo repo:acme/app',
      'https://github.com/Acme/app/issues/7 sub_issue_of https://github.com/Acme/app/issues/1',
      'https://github.com/Acme/app/issues/9 in_repo repo:acme/app',
      `https://github.com/Acme/app/issues/9 sub_issue_of ${ISSUE}`,
      `https://github.com/Acme/app/pull/8 closes ${ISSUE}`,
      'https://github.com/Acme/app/pull/8 in_repo repo:acme/app',
      'https://github.com/orgs/Acme/projects/3 owned_by owner:acme',
      `https://github.com/other/lib/issues/2 in_repo repo:other/lib`,
      `https://github.com/other/lib/issues/2 references ${ISSUE}`,
      'repo:acme/app owned_by owner:acme',
      'repo:other/lib owned_by owner:other',
    ]);
  });

  it('an issue with nothing linked is only its repository and owner', () => {
    const alone = placeGraph({ ...place, projects: [], closedBy: [], references: [], subIssues: [], parent: undefined } as IssuePlace);
    expect(alone.edges.map((e) => e.kind).sort()).toEqual(['in_repo', 'owned_by']);
  });

  it('links the issue to each issue that blocks it (issue #900)', () => {
    const { edges } = placeGraph({ ...place, blockedBy: [{ kind: 'issue', repo: 'Acme/app', number: 3, url: 'https://github.com/Acme/app/issues/3', state: 'open' }] });
    expect(edges.map((e) => `${e.from} ${e.kind} ${e.to}`)).toContain(`${ISSUE} blocked_by https://github.com/Acme/app/issues/3`);
  });

  it('keeps why a closed issue and a closed linked issue closed (issue #1036)', () => {
    const { nodes } = placeGraph({ ...place, issue: { ...place.issue, state: 'closed', stateReason: 'completed' },
      subIssues: [{ kind: 'issue', repo: 'Acme/app', number: 9, url: 'https://github.com/Acme/app/issues/9', state: 'closed', stateReason: 'not_planned' }] });
    expect(nodes.find((n) => n.id === ISSUE)!.attrs).toMatchObject({ state: 'closed', stateReason: 'completed' });
    expect(nodes.find((n) => n.id === 'https://github.com/Acme/app/issues/9')!.attrs).toMatchObject({ state: 'closed', stateReason: 'not_planned' });
  });
});
