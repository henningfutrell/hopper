// The migration lists only grow, and their numbers are given out at merge time (issue #967): the newest migrations of each
// track are in a file of their own, which the repository's .gitattributes marks `hopper-merge=additions`, so the hopper's
// base merge keeps the migrations two pull requests each appended, the base branch's first, with no job.
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const attribute = (path: string): string =>
  execFileSync('git', ['check-attr', 'hopper-merge', '--', path], { encoding: 'utf8' }).trim().split(': ').pop()!;

describe('the migration lists (issue #967)', () => {
  it('marks the files new migrations are appended to as additions files', () => {
    expect(attribute('src/store/migrations-recent.ts')).toBe('additions');
    expect(attribute('src/store/tenant-migrations-recent.ts')).toBe('additions');
    expect(attribute('src/store/migrations.ts')).toBe('unspecified');
  });
});
