// Issue #651: a proposal is a set of paths. Its document is read into a problem statement and 0..N paths, each with its
// title, TL;DR, tradeoffs and what it creates; the recommended path or combination and why; zero paths with the reason.
// A document not written as paths — a proposal from before them — reads as one path. A selection names viable paths
// only; a reviewer level may add a path or mark one not viable; the pre-check names each structural gap.
import { describe, expect, it } from 'vitest';
import {
  amendPaths, pathGaps, pathsOf, proposalDocument, recommendationOf, reviewDocument, selectionRefusal, type ProposalPathSet,
} from '../../src/domain/types.ts';
import { preCheck } from '../../src/review/pre-check.ts';
import { LEGACY, NO_PATHS, THREE_PATHS } from '../support/proposal-paths.ts';

describe('a proposal read as paths', () => {
  it('reads the problem, each path with its TL;DR, tradeoffs and what it creates, and the recommendation', () => {
    const d = proposalDocument(THREE_PATHS);
    expect(d.sections).toMatchObject({
      tldr: 'Paint the shed with a brush. It is cheap and safe.', problem: 'The shed is bare wood, and it rots in the rain.',
      recommended: '1 and 3 — the brush is cheap; look again next year.', context: 'the shed is bare wood.',
    });
    expect(d.missing).toEqual([]);
    expect(d.paths.recommendation).toBe('the brush is cheap; look again next year.');
    expect(d.paths.paths.map((p) => [p.id, p.title, p.recommended ?? false])).toEqual([['1', 'Brush two coats', true], ['2', 'Spray gun', false], ['3', 'Leave it bare', true]]);
    expect(d.paths.paths[0]).toMatchObject({
      summary: 'Two coats of oil paint, with a brush.', creates: 'one job.',
      tradeoffs: { security: 'no change.', effort: 'one afternoon.', risk: 'rain on the second day.', friction: 'the person buys the paint.' },
    });
    expect(d.paths.paths[0]!.text).toContain('The brush reaches the **corners**.');
    expect(d.paths.paths[1]).toMatchObject({ summary: 'Rent a spray gun.', tradeoffs: { risk: 'overspray on the car.' } });
    expect(d.paths.single).toBeUndefined();
  });

  it('zero paths is valid with the reason: no recommendation is needed', () => {
    const d = proposalDocument(NO_PATHS);
    expect(d.paths).toEqual({ paths: [], none: 'the shed was painted last year.' });
    expect(d.missing).toEqual([]);
    expect(proposalDocument('TL;DR: x\nProblem: y\nRecommended: none — no viable path was found.\nContext: z').paths).toEqual({ paths: [], none: 'no viable path was found.' });
  });

  it('a document not written as paths reads as one path, named by its goal', () => {
    const d = proposalDocument(LEGACY);
    expect(d.paths.single).toBe(true);
    expect(d.paths.paths).toEqual([expect.objectContaining({
      id: '1', title: 'paint the shed', summary: 'two coats with a brush', recommended: true, text: LEGACY,
      tradeoffs: { risk: 'rain on the second day', effort: 'an afternoon' },
    })]);
    expect(d.missing).toEqual(['tldr', 'problem', 'paths']);
  });

  it('a version stored before paths reads its one path from its text', () => {
    expect(pathsOf({ text: LEGACY }).paths.map((p) => p.title)).toEqual(['paint the shed']);
    const stored: ProposalPathSet = { paths: [], none: 'kept' };
    expect(pathsOf({ text: LEGACY, paths: stored })).toBe(stored);
  });

  it('a review document carries paths only for a proposal', () => {
    expect(reviewDocument('proposal', THREE_PATHS).paths?.paths).toHaveLength(3);
    expect(reviewDocument('research', 'Findings: x').paths).toBeUndefined();
  });

  it('prose that names a path does not start one', () => {
    const d = proposalDocument(`${THREE_PATHS}\nPath 1 is cheaper than path 2.`);
    expect(d.paths.paths).toHaveLength(3);
  });

  it('reads the recommendation in the ways agents write it', () => {
    expect(recommendationOf('Path 2, because it is quick.')).toEqual({ ids: ['2'], why: 'it is quick.', none: false });
    expect(recommendationOf('paths 1 + 3: both together')).toEqual({ ids: ['1', '3'], why: 'both together', none: false });
    expect(recommendationOf('none — nothing to do')).toEqual({ ids: [], why: 'nothing to do', none: true });
  });
});

describe('a selection', () => {
  const set = proposalDocument(THREE_PATHS).paths;
  it('names one or more viable paths, each once', () => {
    expect(selectionRefusal(set, [{ id: '1' }, { id: '3', note: 'next year' }], true)).toBeUndefined();
    expect(selectionRefusal(set, [], true)).toMatch(/select at least one path/);
    expect(selectionRefusal(set, [{ id: '9' }], true)).toMatch(/no path 9/);
    expect(selectionRefusal(set, [{ id: '1' }, { id: '1' }], true)).toMatch(/selected twice/);
    const amended = amendPaths(set, { notViable: [{ id: '2', why: 'no spray gun for rent nearby' }] }, 'fable').set;
    expect(selectionRefusal(amended, [{ id: '2' }], true)).toMatch(/not viable: no spray gun/);
  });

  it('on zero paths, accept takes none', () => {
    const none = proposalDocument(NO_PATHS).paths;
    expect(selectionRefusal(none, [], true)).toBeUndefined();
    expect(selectionRefusal(none, [{ id: '1' }], true)).toMatch(/no path to select/);
  });
});

describe('a reviewer level amends the paths', () => {
  it('adds a path numbered after the last, and marks one not viable', () => {
    const set = proposalDocument(THREE_PATHS).paths;
    const r = amendPaths(set, {
      add: [{ title: 'Stain it', summary: 'A wood stain, one coat.', tradeoffs: { effort: 'one hour' }, creates: 'one job' }],
      notViable: [{ id: '2', why: 'no spray gun for rent nearby' }, { id: '7', why: 'no such path' }],
    }, 'fable');
    expect(r.added).toEqual(['4']);
    expect(r.notViable).toEqual(['2']);
    expect(r.set.paths.map((p) => [p.id, p.addedBy, p.notViable?.why])).toEqual([
      ['1', undefined, undefined], ['2', undefined, 'no spray gun for rent nearby'], ['3', undefined, undefined], ['4', 'fable', undefined],
    ]);
    expect(r.set.paths[3]).toMatchObject({ title: 'Stain it', summary: 'A wood stain, one coat.', tradeoffs: { effort: 'one hour' }, creates: 'one job' });
  });
});

describe('the pre-check of a proposal\'s paths', () => {
  const version = (text: string, number = 1) => ({ number, text, ...reviewDocument('proposal', text), recentOutput: '', at: '2026-10-10T00:00:00.000Z' });

  it('passes a complete path set, and zero paths with a reason', () => {
    expect(preCheck('proposal', [version(THREE_PATHS)])).toEqual([]);
    expect(preCheck('proposal', [version(NO_PATHS)])).toEqual([]);
  });

  it('names a path that leaves out parts, and a set with no recommendation', () => {
    const text = THREE_PATHS.replace('Friction: the person buys the paint.\nCreates: one job.\n', '').replace('Recommended: 1 and 3 — the brush is cheap; look again next year.\n', '');
    expect(preCheck('proposal', [version(text)])).toEqual([
      'Missing part: Recommended.',
      'Path 1 (Brush two coats) leaves out Friction:, Creates:.',
      'No path is recommended: name the recommended path, or paths, after Recommended:, and say why.',
    ]);
  });

  it('names a document not written as paths', () => {
    expect(preCheck('proposal', [version(LEGACY)])).toEqual([
      'Missing summary: write the TL;DR: part.',
      'Missing part: Problem.',
      'Missing part: Paths.',
      ...pathGaps(proposalDocument(LEGACY).paths),
    ]);
  });
});
