// Push requirements (issue #2555, design.md "Push requirements"): a rule a repository keeps in `.hopper/requirements.yaml`
// — a condition, the checks to run, their pass criteria —, evaluated against a job's diff and context before each push.
import { describe, expect, it } from 'vitest';
import {
  conditionHolds, effectiveRequirements, judgeEvaluation, parseRequirements, planPush, requirementsFileDir,
  type PushContext, type PushRequirement, type RequirementCondition, type RequirementsAt,
} from '../../src/domain/push-requirements.ts';

const ctx = (more: Partial<PushContext> = {}): PushContext => ({
  files: ['src/a/B.kt'], repo: 'octo/identity', branch: 'issue-7', base: 'dev', kind: 'code', labels: ['hopper'], ...more,
});

const coverage: PushRequirement = {
  id: 'kotlin-coverage', when: { paths: ['src/**/*.kt'] },
  checks: [{ name: 'changed-files coverage', run: './gradlew koverVerify', thresholds: { changedLines: { min: 80 }, changedBranches: { min: 70 } } }],
};
const migrations: PushRequirement = {
  id: 'migrations', when: { any: [{ paths: ['**/*.sql'] }, { paths: ['**/migrations/**'] }] },
  checks: [{ name: 'migration tests', run: 'npm run test:migrations' }],
};

describe('a requirements file', () => {
  it('reads YAML (and JSON, which YAML holds) into requirements', () => {
    const yaml = [
      'requirements:',
      '  - id: kotlin-coverage',
      '    when: { paths: ["src/**/*.kt"] }',
      '    checks:',
      '      - name: changed-files coverage',
      '        run: ./gradlew koverVerify',
      '        thresholds: { changedLines: { min: 80 }, changedBranches: { min: 70 } }',
    ].join('\n');
    expect(parseRequirements(yaml)).toEqual({ ok: true, requirements: [coverage] });
    expect(parseRequirements(JSON.stringify({ requirements: [migrations] }))).toEqual({ ok: true, requirements: [migrations] });
  });

  it('refuses a file it cannot read, and says why', () => {
    const problem = (text: string) => { const r = parseRequirements(text); return r.ok ? undefined : r.problem; };
    expect(problem('requirements: [')).toMatch(/not YAML/);
    expect(problem('{}')).toMatch(/requirements/);
    expect(problem(JSON.stringify({ requirements: [{ id: 'Bad id', checks: [{ name: 'x', run: 'true' }] }] }))).toMatch(/Bad id/);
    expect(problem(JSON.stringify({ requirements: [{ id: 'a', checks: [] }] }))).toMatch(/check/);
    expect(problem(JSON.stringify({ requirements: [{ id: 'a', when: { paths: ['/etc/*'] }, checks: [{ name: 'x', run: 'true' }] }] }))).toMatch(/relative/);
    expect(problem(JSON.stringify({ requirements: [{ id: 'a', when: { colour: ['red'] }, checks: [{ name: 'x', run: 'true' }] }] }))).toBeDefined();
    expect(problem(JSON.stringify({ requirements: [{ id: 'a', checks: [{ name: 'x', run: 'true' }] }, { id: 'a', checks: [{ name: 'y', run: 'true' }] }] }))).toMatch(/twice/);
    expect(problem(JSON.stringify({ requirements: [{ id: 'a', checks: [{ name: 'x', run: 'true', thresholds: { lines: { min: 'high' } } }] }] }))).toBeDefined();
  });

  it('is the root one, or one of a folder, whose requirements are path-scoped', () => {
    expect(requirementsFileDir('.hopper/requirements.yaml')).toBe('');
    expect(requirementsFileDir('services/api/.hopper/requirements.yaml')).toBe('services/api');
    expect(requirementsFileDir('docs/requirements.yaml')).toBeUndefined();
  });
});

describe('a condition', () => {
  // Table-driven: each condition over path, branch and base, label and kind-of-work inputs.
  const cases: [string, RequirementCondition, Partial<PushContext>, boolean][] = [
    ['paths match', { paths: ['src/**/*.kt'] }, {}, true],
    ['paths do not match', { paths: ['**/*.sql'] }, {}, false],
    ['a glob with no slash matches a file name in any folder', { paths: ['*.kt'] }, {}, true],
    ['file types', { fileTypes: ['kt'] }, {}, true],
    ['file types with a dot', { fileTypes: ['.sql'] }, {}, false],
    ['repo, any case', { repos: ['Octo/Identity'] }, {}, true],
    ['branch glob', { branches: ['issue-*'] }, {}, true],
    ['base', { bases: ['main'] }, {}, false],
    ['base dev', { bases: ['dev'] }, {}, true],
    ['label, any case', { labels: ['HOPPER'] }, {}, true],
    ['kind of work', { kinds: ['research'] }, {}, false],
    ['a dependency manifest', { dependencies: true }, { files: ['web/package.json'] }, true],
    ['no dependency manifest', { dependencies: true }, {}, false],
    ['a workflow file', { workflows: true }, { files: ['.github/workflows/pr.yml'] }, true],
    ['all: both hold', { all: [{ paths: ['src/**'] }, { bases: ['dev'] }] }, {}, true],
    ['all: one fails', { all: [{ paths: ['src/**'] }, { bases: ['main'] }] }, {}, false],
    ['any: one holds', { any: [{ bases: ['main'] }, { labels: ['hopper'] }] }, {}, true],
    ['any: none holds', { any: [{ bases: ['main'] }, { labels: ['urgent'] }] }, {}, false],
    ['not', { not: { bases: ['main'] } }, {}, true],
    ['not of a holding one', { not: { kinds: ['code'] } }, {}, false],
    ['nested: all of any and not', { all: [{ any: [{ paths: ['**/*.sql'] }, { fileTypes: ['kt'] }] }, { not: { any: [{ bases: ['main'] }, { labels: ['skip-coverage'] }] } }] }, {}, true],
    ['nested: not of all', { not: { all: [{ kinds: ['code'] }, { branches: ['release/*'] }] } }, { branch: 'release/1.2' }, false],
    ['nested, the label skips it', { all: [{ fileTypes: ['kt'] }, { not: { labels: ['skip-coverage'] } }] }, { labels: ['skip-coverage'] }, false],
  ];
  it.each(cases)('%s', (_name, when, more, holds) => {
    expect(conditionHolds(when, ctx(more)).holds).toBe(holds);
  });

  it('says why it does not hold', () => {
    expect(conditionHolds({ paths: ['**/*.sql'] }, ctx()).why).toBe('no changed files match `**/*.sql`');
    expect(conditionHolds({ all: [{ paths: ['src/**'] }, { bases: ['main'] }] }, ctx()).why).toBe('the base dev is not `main`');
    expect(conditionHolds({ not: { labels: ['hopper'] } }, ctx()).why).toBe('not: the label hopper is one of `hopper`');
  });
});

describe('the requirements that apply', () => {
  const at = (more: Partial<RequirementsAt>): RequirementsAt => ({ ...more });
  const strict = (min: number): PushRequirement => ({ ...coverage, checks: [{ ...coverage.checks[0]!, thresholds: { changedLines: { min } } }] });

  it('a repository with no requirements file gets the hopper defaults', () => {
    expect(effectiveRequirements(at({ defaults: [coverage] })).map((r) => [r.id, r.level])).toEqual([['kotlin-coverage', 'default']]);
  });

  it('job override over a path-scoped rule over a repo rule over the default; a stricter threshold and a looser one', () => {
    const lines = (a: RequirementsAt) => effectiveRequirements(a).find((r) => r.id === 'kotlin-coverage')!.checks[0]!.thresholds!.changedLines!.min;
    expect(lines(at({ defaults: [strict(80)], repo: [strict(90)] }))).toBe(90); // the repo is stricter
    expect(lines(at({ defaults: [strict(80)], repo: [strict(60)] }))).toBe(60); // and may be looser
    expect(lines(at({ defaults: [strict(80)], repo: [strict(90)], scoped: [{ dir: 'src', requirements: [strict(95)] }] }))).toBe(95);
    expect(lines(at({ defaults: [strict(80)], repo: [strict(90)], scoped: [{ dir: 'src', requirements: [strict(95)] }], job: [strict(50)] }))).toBe(50);
    const all = effectiveRequirements(at({ defaults: [coverage, migrations], repo: [strict(90)], job: [strict(70)] }));
    expect(all.map((r) => [r.id, r.level])).toEqual([['kotlin-coverage', 'job'], ['migrations', 'default']]);
  });

  it('a path-scoped requirement holds only for changes in its folder, and runs there', () => {
    const [scoped] = effectiveRequirements(at({ scoped: [{ dir: 'services/api', requirements: [{ id: 'api', checks: [{ name: 'api tests', run: 'npm test' }] }] }] }));
    expect(scoped).toMatchObject({ id: 'api', level: 'path', dir: 'services/api' });
    expect(planPush([scoped!], ctx({ files: ['services/api/x.ts'] })).matched).toHaveLength(1);
    expect(planPush([scoped!], ctx({ files: ['web/x.ts'] })).skipped).toEqual([{ id: 'api', level: 'path', reason: 'no changed files match `services/api/**`' }]);
  });
});

describe('a push plan (the dry run)', () => {
  it('lists the matched requirements with their commands, and the skipped ones with why; it runs nothing', () => {
    const plan = planPush(effectiveRequirements({ repo: [coverage, migrations] }), ctx());
    expect(plan.matched).toEqual([{
      id: 'kotlin-coverage', level: 'repo', why: 'changed files match `src/**/*.kt`: src/a/B.kt', checks: coverage.checks,
    }]);
    expect(plan.skipped).toEqual([{ id: 'migrations', level: 'repo', reason: 'no changed files match `**/*.sql`; and no changed files match `**/migrations/**`' }]);
  });

  it('a requirement with no condition always applies', () => {
    expect(planPush(effectiveRequirements({ repo: [{ id: 'lint', checks: [{ name: 'lint', run: 'npm run lint' }] }] }), ctx()).matched).toHaveLength(1);
  });
});

describe('an evaluation', () => {
  const plan = planPush(effectiveRequirements({ repo: [coverage, migrations, { id: 'lint', checks: [{ name: 'lint', run: 'npm run lint' }] }] }), ctx());

  it('passes when every matched requirement passes, and records the skipped with why', () => {
    const judged = judgeEvaluation(plan, [
      { id: 'kotlin-coverage', checks: [{ name: 'changed-files coverage', exit: 0, measured: { changedLines: 84, changedBranches: 71 } }] },
      { id: 'lint', checks: [{ name: 'lint', exit: 0 }] },
    ]);
    expect(judged.passed).toBe(true);
    expect(judged.requirements).toEqual([
      { id: 'kotlin-coverage', level: 'repo', status: 'passed', checks: [{ name: 'changed-files coverage', run: './gradlew koverVerify', exit: 0, thresholds: { changedLines: { min: 80 }, changedBranches: { min: 70 } }, measured: { changedLines: 84, changedBranches: 71 }, passed: true }] },
      { id: 'lint', level: 'repo', status: 'passed', checks: [{ name: 'lint', run: 'npm run lint', exit: 0, passed: true }] },
      { id: 'migrations', level: 'repo', status: 'skipped', reason: expect.stringContaining('no changed files match `**/*.sql`') },
    ]);
  });

  it('fails when one matched requirement fails: its exit, or a threshold it misses, or a measure it did not print', () => {
    const lint = { id: 'lint', checks: [{ name: 'lint', exit: 0 }] };
    const fails = (coverageRun: { exit: number; measured?: Record<string, number> }) => judgeEvaluation(plan, [{ id: 'kotlin-coverage', checks: [{ name: 'changed-files coverage', ...coverageRun }] }, lint]);
    expect(fails({ exit: 1, measured: { changedLines: 90, changedBranches: 90 } }).passed).toBe(false);
    const missed = fails({ exit: 0, measured: { changedLines: 78, changedBranches: 71 } });
    expect(missed.passed).toBe(false);
    expect(missed.requirements[0]!.checks![0]!.problem).toBe('changedLines 78 is under its minimum 80');
    expect(fails({ exit: 0, measured: { changedLines: 81 } }).requirements[0]!.checks![0]!.problem).toBe('it printed no measure changedBranches (a line hopper-measure changedBranches=<number>)');
    expect(judgeEvaluation(plan, [lint]).requirements[0]).toMatchObject({ id: 'kotlin-coverage', status: 'failed', reason: 'its checks did not run' });
  });
});
