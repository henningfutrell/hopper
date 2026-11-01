// Issue #2890: a person who parks a job may name a park condition — a pull request merges, an issue closes, a job ends, or
// a time —, and the hopper picks the job up by itself once it holds. Pure: how the text reads, and how it is shown.
import { describe, expect, it } from 'vitest';
import { parkUntilLabel, parkUntilOf } from '../../src/domain/park-until.ts';

describe('a park condition from its text (issue #2890)', () => {
  it('an issue or a pull request: by its repository, its name alone (the job\'s owner), its number alone (the job\'s repository), or a link', () => {
    expect(parkUntilOf('octo/supersearch#6', 'acme/tools')).toEqual({ kind: 'item', repo: 'octo/supersearch', number: 6 });
    expect(parkUntilOf('supersearch#6', 'acme/tools')).toEqual({ kind: 'item', repo: 'acme/supersearch', number: 6 });
    expect(parkUntilOf('#6', 'acme/tools')).toEqual({ kind: 'item', repo: 'acme/tools', number: 6 });
    expect(parkUntilOf('https://github.com/octo/supersearch/pull/6', undefined)).toEqual({ kind: 'item', repo: 'octo/supersearch', number: 6 });
  });

  it('a job, and a time', () => {
    expect(parkUntilOf('job 0b5e2c1a', 'acme/tools')).toEqual({ kind: 'job', jobId: '0b5e2c1a' });
    expect(parkUntilOf('job:0b5e2c1a', undefined)).toEqual({ kind: 'job', jobId: '0b5e2c1a' });
    expect(parkUntilOf('2026-11-02T08:00:00Z', undefined)).toEqual({ kind: 'time', at: '2026-11-02T08:00:00.000Z' });
  });

  it('text that names no one condition is refused with why', () => {
    expect(parkUntilOf('#6', undefined)).toMatch(/names no repository/);
    expect(parkUntilOf('octo/a#1 and octo/b#2', undefined)).toMatch(/one condition/);
    expect(parkUntilOf('when it is ready', 'acme/tools')).toMatch(/owner\/name#N/);
    expect(parkUntilOf('octo/x run 12345678', undefined)).toMatch(/owner\/name#N/);
    expect(parkUntilOf('2026-13-45T99:00:00Z', undefined)).toMatch(/not a time/);
  });

  it('shown as a person reads it', () => {
    expect(parkUntilLabel({ kind: 'item', repo: 'octo/supersearch', number: 6 })).toBe('octo/supersearch#6 closes or merges');
    expect(parkUntilLabel({ kind: 'job', jobId: '0b5e2c1a' })).toBe('job 0b5e2c1a ends');
    expect(parkUntilLabel({ kind: 'time', at: '2026-11-02T08:00:00.000Z' })).toBe('2026-11-02T08:00:00.000Z');
  });
});
