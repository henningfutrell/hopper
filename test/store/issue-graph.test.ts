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
});
