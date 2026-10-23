// Issue #2639 part 2: what a person approved for a job carries to the jobs that run it again (`rerunOf`): the chain of an
// item's jobs, both ways, and a template approved for one job's runs only covers its reruns too.
import { describe, expect, it } from 'vitest';
import { earlierRuns, laterRuns, RERUN_DEPTH } from '../../src/domain/rerun-chain.ts';
import { approvalCovers, withReruns, type Template } from '../../src/domain/vault.ts';

type J = { id: string; rerunOf?: string; source?: { key: string } };

function chain(...jobs: J[]) {
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const jobOf = (id: string) => byId.get(id) as never;
  // The newest job of a key: the last one given.
  const newestOf = (key: string) => [...jobs].reverse().find((j) => j.source?.key === key) as never;
  return { jobOf, newestOf };
}

const KEY = { key: 'direct:d1' };

describe('the reruns of a job (issue #2639 part 2)', () => {
  it('walks back from a rerun to the jobs it runs again, newest first', () => {
    const c = chain({ id: 'a', source: KEY }, { id: 'b', rerunOf: 'a', source: KEY }, { id: 'c', rerunOf: 'b', source: KEY });
    expect(earlierRuns('c', c.jobOf)).toEqual(['b', 'a']);
    expect(earlierRuns('a', c.jobOf)).toEqual([]);
    expect(earlierRuns('gone', c.jobOf)).toEqual([]);
  });

  it('finds the jobs that run a job again, from its item\'s newest job back to it', () => {
    const c = chain({ id: 'a', source: KEY }, { id: 'b', rerunOf: 'a', source: KEY }, { id: 'c', rerunOf: 'b', source: KEY });
    expect(laterRuns('a', c.jobOf, c.newestOf)).toEqual(['b', 'c']);
    expect(laterRuns('c', c.jobOf, c.newestOf)).toEqual([]);
  });

  it('a job of another item, a job with no source, and a fork are no reruns', () => {
    const c = chain({ id: 'a', source: KEY }, { id: 'x', source: { key: 'other' } }, { id: 'n' });
    expect(laterRuns('a', c.jobOf, c.newestOf)).toEqual([]);
    expect(laterRuns('n', c.jobOf, c.newestOf)).toEqual([]);
    expect(earlierRuns('x', c.jobOf)).toEqual([]);
  });

  it('stops after RERUN_DEPTH jobs, and on a loop', () => {
    const jobs: J[] = Array.from({ length: RERUN_DEPTH + 5 }, (_, i) => ({ id: `j${i}`, ...(i ? { rerunOf: `j${i - 1}` } : {}), source: KEY }));
    const c = chain(...jobs);
    expect(earlierRuns(`j${RERUN_DEPTH + 4}`, c.jobOf)).toHaveLength(RERUN_DEPTH);
    expect(laterRuns('j0', c.jobOf, c.newestOf)).toEqual([]);
    const loop = chain({ id: 'p', rerunOf: 'q', source: KEY }, { id: 'q', rerunOf: 'p', source: KEY });
    expect(earlierRuns('p', loop.jobOf)).toEqual(['q']);
  });
});

describe('a template approved for one job\'s runs covers its reruns (issue #2639 part 2)', () => {
  const t = { name: 'kube', image: 'i', secrets: [], approval: { image: 'i', secrets: [], by: 'Ada', at: 'now', jobs: ['a'] } } as unknown as Template;

  it('adds the reruns of each job the approval names', () => {
    const c = chain({ id: 'a', source: KEY }, { id: 'b', rerunOf: 'a', source: KEY });
    const later = (id: string) => laterRuns(id, c.jobOf, c.newestOf);
    expect(approvalCovers(t, 'b')).toBe(false);
    const carried = withReruns(t, later);
    expect(carried.approval?.jobs).toEqual(['a', 'b']);
    expect(approvalCovers(carried, 'b')).toBe(true);
    expect(approvalCovers(carried, 'other')).toBe(false);
  });

  it('leaves a template approved for every job, or for no job, as it is', () => {
    const every = { ...t, approval: { ...t.approval!, jobs: undefined } } as Template;
    expect(withReruns(every, () => ['z'])).toBe(every);
    const none = { ...t, approval: undefined } as Template;
    expect(withReruns(none, () => ['z'])).toBe(none);
    expect(withReruns(t, () => [])).toBe(t);
  });
});
