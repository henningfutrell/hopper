// The issue graph in the database (issue #437, tenant migration 42): a read of an issue adds or updates its nodes and
// replaces the edges its read before gave; nodes stay, and other issues' edges are left alone.
import { describe, expect, it } from 'vitest';
import type { IssueGraph } from '../../src/domain/issue-graph.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();
const A = 'https://github.com/o/r/issues/1';
const B = 'https://github.com/o/r/issues/2';
const PROJECT = 'https://github.com/orgs/o/projects/1';
const lines = (g: Pick<IssueGraph, 'edges'>) => g.edges.map((e) => `${e.from} ${e.kind} ${e.to}`).sort();

const readOfA = (over: Partial<IssueGraph> = {}): IssueGraph => ({
  nodes: [
    { id: A, kind: 'issue', attrs: { title: 'One', state: 'open', updatedAt: 'u1' } },
    { id: 'repo:o/r', kind: 'repo', attrs: { name: 'o/r' } },
    { id: 'owner:o', kind: 'owner', attrs: { login: 'o', type: 'Organization' } },
    { id: PROJECT, kind: 'project', attrs: { title: 'Board' } },
  ],
  edges: [
    { from: A, kind: 'in_repo', to: 'repo:o/r' },
    { from: 'repo:o/r', kind: 'owned_by', to: 'owner:o' },
    { from: A, kind: 'in_project', to: PROJECT },
  ],
  ...over,
});

describe('the issue graph in the database', () => {
  it('keeps the nodes and edges of a read, and when it was made', () => {
    const store = t.open(t.url());
    store.issueGraph.record(A, readOfA(), '2026-10-11T10:00:00.000Z');
    expect(store.issueGraph.node(A)).toEqual({ id: A, kind: 'issue', attrs: { title: 'One', state: 'open', updatedAt: 'u1' } });
    expect(store.issueGraph.nodes('owner').map((n) => n.id)).toEqual(['owner:o']);
    expect(lines({ edges: store.issueGraph.edges() })).toEqual([`${A} in_project ${PROJECT}`, `${A} in_repo repo:o/r`, 'repo:o/r owned_by owner:o']);
    expect(store.issueGraph.lastRead(A)).toEqual({ readAt: '2026-10-11T10:00:00.000Z', updatedAt: 'u1' });
    expect(store.issueGraph.lastRead(B)).toBeUndefined();
    store.close();
  });

  it('a new read replaces the edges the read before gave, keeps every node and merges what it says of one', () => {
    const store = t.open(t.url());
    store.issueGraph.record(A, readOfA(), '2026-10-11T10:00:00.000Z');
    store.issueGraph.record(B, {
      nodes: [{ id: B, kind: 'issue', attrs: { state: 'open' } }, { id: 'owner:o', kind: 'owner', attrs: { login: 'o' } }],
      edges: [{ from: B, kind: 'in_repo', to: 'repo:o/r' }, { from: 'repo:o/r', kind: 'owned_by', to: 'owner:o' }, { from: B, kind: 'references', to: A }],
    }, '2026-10-11T10:01:00.000Z');
    // Issue A left the Project and was closed.
    const after = readOfA({ edges: readOfA().edges.filter((e) => e.kind !== 'in_project') });
    after.nodes[0] = { id: A, kind: 'issue', attrs: { state: 'closed', updatedAt: 'u2' } };
    store.issueGraph.record(A, after, '2026-10-11T11:00:00.000Z');

    expect(lines({ edges: store.issueGraph.edges() })).toEqual([`${A} in_repo repo:o/r`, `${B} in_repo repo:o/r`, `${B} references ${A}`, 'repo:o/r owned_by owner:o']);
    expect(store.issueGraph.node(PROJECT)).toBeDefined();
    expect(store.issueGraph.node(A)!.attrs).toEqual({ title: 'One', state: 'closed', updatedAt: 'u2' });
    expect(store.issueGraph.node('owner:o')!.attrs).toEqual({ login: 'o', type: 'Organization' });
    expect(store.issueGraph.lastRead(A)).toEqual({ readAt: '2026-10-11T11:00:00.000Z', updatedAt: 'u2' });
    // A node only named by another read was never read itself.
    expect(store.issueGraph.lastRead(PROJECT)).toBeUndefined();
    store.close();
  });

  it('the graph refresh (issue #1036): the issues and pull requests not settled, and their new states kept, edges untouched', () => {
    const store = t.open(t.url());
    const PR = 'https://github.com/o/r/pull/3';
    const C = 'https://github.com/o/r/issues/4';
    store.issueGraph.record(A, readOfA({
      nodes: [
        ...readOfA().nodes,
        { id: B, kind: 'issue', attrs: { repo: 'o/r', number: 2, state: 'closed', stateReason: 'completed' } },
        { id: PR, kind: 'pull_request', attrs: { repo: 'o/r', number: 3, state: 'open' } },
        { id: C, kind: 'issue', attrs: { repo: 'o/r', number: 4 } },
      ],
      edges: [...readOfA().edges, { from: PR, kind: 'closes', to: A }],
    }), '2026-10-11T10:00:00.000Z');
    expect(store.issueGraph.unsettled().map((n) => [n.id, n.readAt])).toEqual([
      [A, '2026-10-11T10:00:00.000Z'], [C, undefined], [PR, undefined],
    ]);

    store.issueGraph.keepStates([
      { id: PR, attrs: { state: 'merged' } }, { id: C, attrs: { state: 'closed', stateReason: 'not_planned' } },
      { id: 'https://github.com/o/r/issues/99', attrs: { state: 'closed' } },
    ]);
    expect(store.issueGraph.node(PR)!.attrs).toEqual({ repo: 'o/r', number: 3, state: 'merged' });
    expect(store.issueGraph.node(C)!.attrs).toEqual({ repo: 'o/r', number: 4, state: 'closed', stateReason: 'not_planned' });
    expect(store.issueGraph.node('https://github.com/o/r/issues/99')).toBeUndefined();
    expect(store.issueGraph.unsettled().map((n) => n.id)).toEqual([A]);
    expect(lines({ edges: store.issueGraph.edges() })).toContain(`${PR} closes ${A}`);
    expect(store.issueGraph.lastRead(A)).toEqual({ readAt: '2026-10-11T10:00:00.000Z', updatedAt: 'u1' });

    // An issue opened again forgets why it closed.
    store.issueGraph.keepStates([{ id: C, attrs: { state: 'open' } }]);
    expect(store.issueGraph.node(C)!.attrs).toEqual({ repo: 'o/r', number: 4, state: 'open' });
    store.close();
  });
});

