// The push requirements summary (issue #2555 part 4, design.md "Push requirements"): the evaluation of a pull request's
// pushed commit, as a section of its body that the hopper keeps — each requirement's status, each check's command,
// thresholds and measured values.
import { describe, expect, it } from 'vitest';
import { SUMMARY_END, SUMMARY_START, pushRequirementsSummary, withPushRequirementsSummary } from '../../src/domain/push-requirements-summary.ts';
import { postKeyLine } from '../../src/domain/post-key.ts';

const evaluation = {
  repo: 'octo/identity', branch: 'issue-440', base: 'dev', head: '4f1c2a9e8b7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b', passed: true,
  requirements: [
    { id: 'kotlin-coverage', level: 'repo' as const, status: 'passed' as const, checks: [{ name: 'changed-files coverage', run: './gradlew koverVerify', exit: 0, thresholds: { changedLines: { min: 80 }, changedBranches: { min: 70, max: 100 } }, measured: { changedLines: 84, changedBranches: 71.5 }, passed: true }] },
    { id: 'lint', level: 'default' as const, status: 'passed' as const, checks: [{ name: 'lint | strict', run: 'npm run lint -- --max-warnings=0 | tee `lint.log`', exit: 0, passed: true }] },
    { id: 'migrations', level: 'repo' as const, status: 'skipped' as const, reason: 'no changed files match `**/*.sql`' },
  ],
};

describe('the push requirements summary', () => {
  it('names the commit and its base, and each requirement: status, command, thresholds and measured values', () => {
    const text = pushRequirementsSummary(evaluation);
    expect(text.startsWith(SUMMARY_START)).toBe(true);
    expect(text.endsWith(SUMMARY_END)).toBe(true);
    expect(text).toContain('### Push requirements');
    expect(text).toContain('Passed for `4f1c2a9e8b7d` against `dev`');
    expect(text).toContain('| `kotlin-coverage` | repo | passed | changed-files coverage | `./gradlew koverVerify` | changedLines ≥ 80, 70 ≤ changedBranches ≤ 100 | changedLines 84, changedBranches 71.5 |');
    // A pipe or a backtick in a cell does not break the table or the code span.
    expect(text).toContain('| `lint` | default | passed | lint \\| strict | `` npm run lint -- --max-warnings=0 \\| tee `lint.log` `` | | |');
    expect(text).toContain('| `migrations` | repo | skipped: no changed files match `**/*.sql` | | | | |');
  });

  it('a failed check says why', () => {
    const failed = {
      ...evaluation, passed: false,
      requirements: [{ id: 'kotlin-coverage', level: 'job' as const, status: 'failed' as const, checks: [{ name: 'coverage', run: 'cat c.txt', exit: 0, thresholds: { changedLines: { min: 80 } }, measured: { changedLines: 76 }, passed: false, problem: 'changedLines 76 is under its minimum 80' }] }],
    };
    const text = pushRequirementsSummary(failed);
    expect(text).toContain('Failed for `4f1c2a9e8b7d` against `dev`');
    expect(text).toContain('| `kotlin-coverage` | job | failed: changedLines 76 is under its minimum 80 | coverage | `cat c.txt` | changedLines ≥ 80 | changedLines 76 |');
  });

  it('says so when no requirement applied', () => {
    expect(pushRequirementsSummary({ ...evaluation, requirements: [] })).toContain('No push requirement applied.');
  });
});

describe('a body with the summary', () => {
  const summary = pushRequirementsSummary(evaluation);
  const other = pushRequirementsSummary({ ...evaluation, head: 'a'.repeat(40) });

  it('ends with it, when the body has none', () => {
    expect(withPushRequirementsSummary('Closes #7', summary)).toBe(`Closes #7\n\n${summary}`);
    expect(withPushRequirementsSummary('', summary)).toBe(summary);
  });

  it('keeps the post key line last', () => {
    const key = postKeyLine('proxy-1');
    expect(withPushRequirementsSummary(`Closes #7\n\n${key}`, summary)).toBe(`Closes #7\n\n${summary}\n\n${key}`);
  });

  it('replaces the one it has, and keeps the text around it', () => {
    const body = withPushRequirementsSummary(`Closes #7\n\n${summary}\n\nMore text.`, other);
    expect(body).toBe(`Closes #7\n\n${other}\n\nMore text.`);
    expect(body).not.toContain('4f1c2a9e8b7d');
  });
});
