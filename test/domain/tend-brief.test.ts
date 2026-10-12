// The tend brief of failing checks (issue #927): it names the checks that failed, and lets the first fix of a row run a
// flaky check again once before code changes.
import { describe, expect, it } from 'vitest';
import { tendBrief } from '../../src/domain/types.ts';

const PR = 'https://github.com/owner/repo/pull/7';

describe('the tend brief of failing checks (issue #927)', () => {
  it('names each check that failed, with its link', () => {
    const brief = tendBrief(PR, 'fix_checks', { failed: [{ name: 'test (1)', url: 'https://github.com/owner/repo/actions/runs/1' }, { name: 'lint' }] });
    expect(brief).toContain('- test (1): https://github.com/owner/repo/actions/runs/1');
    expect(brief).toContain('- lint\n');
  });

  it('the first fix of a row may run the checks again once; a later one is told to fix the cause', () => {
    expect(tendBrief(PR, 'fix_checks', { rerun: true })).toContain('run the checks again once: push an empty commit');
    const later = tendBrief(PR, 'fix_checks', { rerun: false });
    expect(later).not.toContain('push an empty commit');
    expect(later).toContain('fix the cause');
  });

  it('a rebase is told nothing of checks', () => {
    const brief = tendBrief(PR, 'rebase', { failed: [{ name: 'lint' }], rerun: true });
    expect(brief).not.toContain('lint');
    expect(brief).not.toContain('empty commit');
  });
});
