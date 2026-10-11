// Issue lineage in the UI (issue #729), pure: the links the hopper recorded as jobs filed child issues
// (`job.child_issue_filed`), folded into what a job's card shows of its issue — its parent, its children, required or
// follow-up, and how many descendants it has in all.
import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '../../src/domain/types.ts';
import { lineageLinks, lineageOf } from '../../ui/src/model/lineage.ts';

let seq = 0;
const filed = (parent: [string, number], child: [string, number], required = false, jobId = 'j1'): DomainEvent => ({
  seq: ++seq, id: `e${seq}`, schemaVersion: 1, type: 'job.child_issue_filed', at: '2026-10-11T00:00:00.000Z', jobId,
  data: {
    requestId: `r${seq}`, parent: { repo: parent[0], number: parent[1] },
    child: { repo: child[0], number: child[1], url: `https://github.com/${child[0]}/issues/${child[1]}` }, required,
  },
});

describe('issue lineage', () => {
  const links = lineageLinks([
    filed(['o/r', 7], ['o/r', 8], true), filed(['o/r', 7], ['o/other', 2]), filed(['o/r', 8], ['o/r', 9]),
    { seq: 99, id: 'x', schemaVersion: 1, type: 'job.started', at: '2026-10-11T00:00:00.000Z', data: {} },
  ]);

  it('an issue with no recorded parent or child has none', () => {
    expect(lineageOf(links, 'o/r', 1)).toBeUndefined();
    expect(lineageOf(links, undefined, undefined)).toBeUndefined();
  });

  it('a parent: its children, required or follow-up, named short in its own repository, and its descendants in all', () => {
    expect(lineageOf(links, 'o/r', 7)).toEqual({
      children: [
        { ref: '#8', url: 'https://github.com/o/r/issues/8', required: true },
        { ref: 'o/other#2', url: 'https://github.com/o/other/issues/2', required: false },
      ],
      descendants: 3,
    });
  });

  it('a child: its parent, and its own children; the repository matched in any case', () => {
    expect(lineageOf(links, 'O/R', 8)).toEqual({
      parent: { ref: '#7', url: 'https://github.com/o/r/issues/7', required: true },
      children: [{ ref: '#9', url: 'https://github.com/o/r/issues/9', required: false }],
      descendants: 1,
    });
    expect(lineageOf(links, 'o/other', 2)).toEqual({ parent: { ref: 'o/r#7', url: 'https://github.com/o/r/issues/7', required: false }, children: [], descendants: 0 });
  });

  it('the same child filed twice is one link; a loop counts each issue once', () => {
    const loop = lineageLinks([filed(['o/r', 1], ['o/r', 2]), filed(['o/r', 1], ['o/r', 2]), filed(['o/r', 2], ['o/r', 1])]);
    expect(lineageOf(loop, 'o/r', 1)).toMatchObject({ children: [{ ref: '#2' }], descendants: 1 });
  });
});
