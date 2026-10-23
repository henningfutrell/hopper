// Push requirement metrics (issue #2555 part 5, design.md "Push requirements"): which CI runs a requirement caught on the job's
// machine, the billed minutes that saved, and which CI runs failed on a check a requirement that applied should have caught.
import { describe, expect, it } from 'vitest';
import { ciMissOf, pushRequirementMetrics, type EvaluatedPush, type CiMiss } from '../../src/domain/push-requirement-metrics.ts';
import { judgeEvaluation, planPush, readRequirements, type JudgedRequirement, type PushRequirement } from '../../src/domain/push-requirements.ts';

const coverage: PushRequirement = {
  id: 'kotlin-coverage', when: { paths: ['src/**/*.kt'] },
  checks: [{ name: 'changed-files coverage', run: './gradlew koverVerify', ci: { checks: ['coverage*'], minutes: 47 } }],
};
const lint: PushRequirement = { id: 'lint', checks: [{ name: 'lint', run: 'npm run lint' }] };

const judged = (status: 'passed' | 'failed' | 'skipped', ci?: { checks: string[]; minutes?: number }): JudgedRequirement => (status === 'skipped'
  ? { id: 'kotlin-coverage', level: 'repo', status, reason: 'no changed files match `src/**/*.kt`' }
  : { id: 'kotlin-coverage', level: 'repo', status, checks: [{ name: 'changed-files coverage', run: './gradlew koverVerify', exit: status === 'passed' ? 0 : 1, passed: status === 'passed', ...(ci ? { ci } : {}) }] });
const push = (head: string, at: string, requirements: JudgedRequirement[], repo = 'octo/identity'): EvaluatedPush =>
  ({ repo, head, at, passed: requirements.every((q) => q.status !== 'failed'), requirements });

describe('a check that mirrors a CI check', () => {
  it('is read from a requirements file, and refused when it names no CI check or a minutes figure that is not positive', () => {
    expect(readRequirements({ requirements: [coverage] })).toEqual({ ok: true, requirements: [coverage] });
    const bad = (ci: unknown) => readRequirements({ requirements: [{ id: 'a', checks: [{ name: 'x', run: 'true', ci }] }] }).ok;
    expect(bad({ checks: [] })).toBe(false);
    expect(bad({ checks: ['coverage'], minutes: 0 })).toBe(false);
    expect(bad({ checks: ['coverage'], colour: 'red' })).toBe(false);
  });

  it('is carried into the evaluation, so the record says which CI check it stands for', () => {
    const plan = planPush([{ ...coverage, level: 'repo' }], { files: ['src/a/B.kt'], repo: 'octo/identity', branch: 'b', base: 'dev', kind: 'code', labels: [] });
    const e = judgeEvaluation(plan, [{ id: 'kotlin-coverage', checks: [{ name: 'changed-files coverage', exit: 1 }] }]);
    expect(e.requirements[0]!.checks![0]).toMatchObject({ ci: { checks: ['coverage*'], minutes: 47 }, passed: false });
  });
});

describe('a CI miss', () => {
  const ci = { checks: ['coverage*'], minutes: 47 };
  it('is a failed CI check that a check of an applied requirement mirrors', () => {
    expect(ciMissOf(push('a1', 't', [judged('passed', ci)]), ['test', 'coverage gate'])).toEqual({ checks: ['coverage gate'], requirements: ['kotlin-coverage'], minutes: 47 });
  });
  it('is none when the requirement was skipped, mirrors no CI check, or no failed check matches', () => {
    expect(ciMissOf(push('a1', 't', [judged('skipped')]), ['coverage gate'])).toBeUndefined();
    expect(ciMissOf(push('a1', 't', [judged('passed')]), ['coverage gate'])).toBeUndefined();
    expect(ciMissOf(push('a1', 't', [judged('passed', ci)]), ['test (node 24)'])).toBeUndefined();
  });
  it('has no minutes when its check names none', () => {
    expect(ciMissOf(push('a1', 't', [judged('passed', { checks: ['coverage*'] })]), ['coverage'])).toEqual({ checks: ['coverage'], requirements: ['kotlin-coverage'] });
  });
});

describe('the metrics', () => {
  const ci = { checks: ['coverage*'], minutes: 47 };
  const miss = (head: string, minutes?: number, repo = 'octo/identity'): CiMiss =>
    ({ repo, pullRequest: `https://github.com/${repo}/pull/3`, head, checks: ['coverage'], requirements: ['kotlin-coverage'], ...(minutes ? { minutes } : {}) });

  it('count a commit whose newest evaluation failed on a check that mirrors CI as one CI run caught, with its minutes saved', () => {
    const m = pushRequirementMetrics([
      push('a1', '2026-10-01T10:00:00Z', [judged('failed', ci)]),
      push('a1', '2026-10-01T10:05:00Z', [judged('failed', ci)]),
      push('b2', '2026-10-01T11:00:00Z', [judged('failed', ci)]),
      push('c3', '2026-10-01T12:00:00Z', [judged('passed', ci)]),
    ], []);
    expect(m).toMatchObject({ caught: 2, minutesSaved: 94, unpriced: 0, missed: 0, minutesMissed: 0 });
  });

  it('do not count a commit whose newest evaluation passed (a flake), or that failed only on a check with no CI check', () => {
    const m = pushRequirementMetrics([
      push('a1', '2026-10-01T10:00:00Z', [judged('failed', ci)]),
      push('a1', '2026-10-01T10:05:00Z', [judged('passed', ci)]),
      push('b2', '2026-10-01T11:00:00Z', [judged('failed')]),
    ], []);
    expect(m.caught).toBe(0);
  });

  it('count a caught run with no minutes as unpriced', () => {
    expect(pushRequirementMetrics([push('a1', 't', [judged('failed', { checks: ['coverage'] })])], [])).toMatchObject({ caught: 1, minutesSaved: 0, unpriced: 1 });
  });

  it('count each CI miss once, with its minutes, and each repository apart', () => {
    const m = pushRequirementMetrics(
      [push('a1', 't', [judged('failed', ci)]), push('z9', 't', [judged('failed', ci)], 'octo/tools')],
      [miss('d4', 47), miss('d4', 47), miss('e5'), miss('f6', 30, 'octo/tools')],
    );
    expect(m).toMatchObject({ caught: 2, minutesSaved: 94, missed: 3, minutesMissed: 77 });
    expect(m.repos).toEqual([
      { repo: 'octo/identity', caught: 1, minutesSaved: 47, unpriced: 0, missed: 2, minutesMissed: 47 },
      { repo: 'octo/tools', caught: 1, minutesSaved: 47, unpriced: 0, missed: 1, minutesMissed: 30 },
    ]);
  });

  it('are all zero with nothing recorded', () => {
    expect(pushRequirementMetrics([], [])).toEqual({ caught: 0, minutesSaved: 0, unpriced: 0, missed: 0, minutesMissed: 0, repos: [] });
  });

  it('never count a requirement whose checks name no CI check, by its name alone', () => {
    expect(ciMissOf(push('a1', 't', [{ id: lint.id, level: 'repo', status: 'passed', checks: [{ name: 'lint', run: 'npm run lint', exit: 0, passed: true }] }]), ['lint'])).toBeUndefined();
  });
});
