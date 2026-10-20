// The shrink guard (issue #1096), pure: which files a push that brings in its base branch empties or shrinks, and the
// pull request's own change did not; why the push is refused; and why a job whose last push it refused does not end done.
//
// Feature: the shrink guard
//   Scenario: a resolution empties a large file the pull request only edited
//     Then the file is named, against the base branch
//   Scenario: the pull request's own change removes or shrinks the file
//     Then nothing is named
//   Scenario: the pull request's own change shrinks the file, and the push empties it or loses what the branch kept (issue #1218)
//     Then the file is named, against the branch's head
//   Scenario: a small edit, or the base branch's own shrink
//     Then nothing is named
import { describe, expect, it } from 'vitest';
import { DEFAULT_SHRINK_GUARD, loses, shrinkReason, shrinkRefusalOf, shrunkFiles, SHRUNK_NAMED } from '../../src/domain/shrink-guard.ts';
import type { DomainEvent } from '../../src/domain/types.ts';

const P = DEFAULT_SHRINK_GUARD.percent;

describe('loses', () => {
  it('a file emptied or removed, at any percent; more than the percent of its lines', () => {
    expect(loses(10, 0, 100)).toBe(true);
    expect(loses(10, undefined, 100)).toBe(true);
    expect(loses(100, 49, 50)).toBe(true);
    expect(loses(100, 50, 50)).toBe(false);
    expect(loses(100, 99, 50)).toBe(false);
    expect(loses(1, 0, 50)).toBe(true);
  });

  it('a file that was not there, or empty, loses nothing', () => {
    expect(loses(undefined, 0, 50)).toBe(false);
    expect(loses(0, undefined, 50)).toBe(false);
  });
});

describe('shrunkFiles (issue #1096)', () => {
  it('a resolution that empties a large file the pull request only edited', () => {
    const files = [
      { path: 'docs/design.md', start: 18_000, head: 18_010, base: 18_034, pushed: 0 },
      { path: 'docs/glossary.md', start: 780, head: 781, base: 781, pushed: undefined },
    ];
    expect(shrunkFiles(files, P)).toEqual([
      { path: 'docs/design.md', from: 18_034, to: 0, against: 'base' },
      { path: 'docs/glossary.md', from: 781, to: 0, against: 'base' },
    ]);
  });

  it('the pull request removes or heavily shrinks the file itself: what it means to do', () => {
    expect(shrunkFiles([
      { path: 'old.ts', start: 300, head: undefined, base: 310, pushed: undefined },
      { path: 'big.md', start: 1000, head: 100, base: 1020, pushed: 110 },
    ], P)).toEqual([]);
  });

  it('the pull request shrinks the file itself, and the push empties it or loses much more (issue #1218)', () => {
    expect(shrunkFiles([
      { path: 'docs/design.md', start: 1000, head: 400, base: 1020, pushed: 0 },
      { path: 'docs/glossary.md', start: 1000, head: 400, base: 1000, pushed: undefined },
      { path: 'big.md', start: 1000, head: 400, base: 1000, pushed: 150 },
    ], P)).toEqual([
      { path: 'docs/design.md', from: 400, to: 0, against: 'head' },
      { path: 'docs/glossary.md', from: 400, to: 0, against: 'head' },
      { path: 'big.md', from: 400, to: 150, against: 'head' },
    ]);
  });

  it('both sides shrink the file, the push keeps lines: the base branch\'s change too', () => {
    expect(shrunkFiles([{ path: 'cut.md', start: 1000, head: 400, base: 300, pushed: 100 }], P)).toEqual([]);
  });

  it('small edits pass', () => {
    expect(shrunkFiles([
      { path: 'src/a.ts', start: 100, head: 104, base: 120, pushed: 118 },
      { path: 'src/new.ts', head: 40, pushed: 40 },
    ], P)).toEqual([]);
  });

  it('the base branch removed or shrank the file: its change, not the push\'s', () => {
    expect(shrunkFiles([
      { path: 'gone.ts', start: 200, head: 210, base: undefined, pushed: undefined },
      { path: 'cut.md', start: 1000, head: 1010, base: 100, pushed: 110 },
    ], P)).toEqual([]);
  });

  it('the pull request\'s own lines lost, where the base branch kept the file', () => {
    expect(shrunkFiles([{ path: 'grown.md', start: 10, head: 1000, base: 12, pushed: 12 }], P))
      .toEqual([{ path: 'grown.md', from: 1000, to: 12, against: 'head' }]);
  });

  it('a file the pull request added is its own: a rebase may rename, empty or remove it (issue #2225)', () => {
    expect(shrunkFiles([
      { path: 'docs/adrs/ADR-0019-dashboard.md', head: 98, pushed: undefined },
      { path: 'docs/adrs/ADR-0020-dashboard.md', pushed: 98 },
      { path: 'src/own.ts', head: 400, pushed: 0 },
      { path: 'src/cut.ts', head: 400, pushed: 10 },
    ], P)).toEqual([]);
  });

  it('a file on the base branch is still judged beside the pull request\'s added ones (issue #2225)', () => {
    expect(shrunkFiles([
      { path: 'docs/adrs/ADR-0019-dashboard.md', head: 98, pushed: undefined },
      { path: 'docs/adrs/README.md', start: 40, head: 41, base: 42, pushed: 0 },
      { path: 'docs/adrs/ADR-0019-kotlin.md', base: 120, pushed: undefined },
      { path: 'docs/glossary.md', start: 780, head: 781, base: 781, pushed: 100 },
    ], P)).toEqual([
      { path: 'docs/adrs/README.md', from: 42, to: 0, against: 'base' },
      { path: 'docs/adrs/ADR-0019-kotlin.md', from: 120, to: 0, against: 'base' },
      { path: 'docs/glossary.md', from: 781, to: 100, against: 'base' },
    ]);
  });

  it('the percent is the guard\'s', () => {
    const f = [{ path: 'a.md', start: 100, head: 100, base: 100, pushed: 70 }];
    expect(shrunkFiles(f, 50)).toEqual([]);
    expect(shrunkFiles(f, 20)).toEqual([{ path: 'a.md', from: 100, to: 70, against: 'base' }]);
  });
});

describe('shrinkReason', () => {
  it('names each file with its lines, on one line', () => {
    const r = shrinkReason([{ path: 'docs/design.md', from: 18_034, to: 0, against: 'base' }, { path: 'grown.md', from: 1000, to: 12, against: 'head' }], 'main');
    expect(r).toContain('docs/design.md (18034 lines on main, 0 after)');
    expect(r).toContain('grown.md (1000 lines before this push, 12 after)');
    expect(r).toContain('Redo the resolution');
    expect(r).not.toContain('\n');
  });

  it(`names at most ${SHRUNK_NAMED} files`, () => {
    const many = Array.from({ length: SHRUNK_NAMED + 3 }, (_, i) => ({ path: `f${i}.md`, from: 10, to: 0, against: 'base' as const }));
    const r = shrinkReason(many, 'dev');
    expect(r).toContain(`f${SHRUNK_NAMED - 1}.md`);
    expect(r).not.toContain(`f${SHRUNK_NAMED}.md`);
    expect(r).toContain('and 3 more');
  });
});

describe('shrinkRefusalOf: a job whose last push the guard refused does not end done', () => {
  let seq = 0;
  const ev = (type: DomainEvent['type'], data: Record<string, unknown>): DomainEvent => ({ seq: ++seq, schemaVersion: 1, id: `e${seq}`, type, at: '2026-10-14T00:00:00.000Z', jobId: 'j1', data });
  const refused = ev('github_proxy.refused', { requestId: 'r', own: true, op: 'git.push', repo: 'o/r', reason: 'x', shrunk: [{ path: 'docs/design.md', from: 10, to: 0, against: 'base' }] });
  const pushed = ev('github_proxy.done', { requestId: 'r', own: true, op: 'git.push', repo: 'o/r' });

  it('refused last: tending failed, the files named', () => {
    expect(shrinkRefusalOf([refused, pushed], true)).toBe('tending failed: the shrink guard refused its last push, which emptied or shrank docs/design.md, and no push went through after');
    expect(shrinkRefusalOf([refused], false)).toMatch(/^the shrink guard refused/);
  });

  it('a push went through after: nothing', () => {
    expect(shrinkRefusalOf([pushed, refused], true)).toBeUndefined();
    expect(shrinkRefusalOf([], true)).toBeUndefined();
  });

  it('another refusal or another operation is not the guard\'s', () => {
    const other = ev('github_proxy.refused', { requestId: 'r', own: true, op: 'git.push', repo: 'o/r', reason: 'default branch' });
    const api = ev('github_proxy.done', { requestId: 'r', own: true, op: 'pr.create', repo: 'o/r' });
    expect(shrinkRefusalOf([other, api, refused], true)).toMatch(/^tending failed/);
  });
});
