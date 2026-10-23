// Conditional skills (issue #1924): which library skills a job gets beside its work skill, by the skill rules — its
// repository, its labels, its kind of work —, why each one, and the done criteria the hopper checks before the job is done.
import { describe, expect, it } from 'vitest';
import {
  allowedDeletesIn, conditionalSkillsCredentials, criteriaLine, destroyedAddresses, doneCriteriaOf, doneFileProblem, mergeHolds, pathsApply, planDestroys, ruleMatch,
  skillRuleProblem, unmetCriteria, withConditionalSkills, type ConditionalSkillChosen, type DoneCriterion,
} from '../../src/domain/conditional-skills.ts';
import { namedSkills, patchWorkSkills, skillFilesProblem } from '../../src/domain/skill-library.ts';
import { builtInSkills } from '../../src/skill-library/index.ts';

const job = { repo: 'Octo/Infra', labels: ['hopper', 'IaC'], kind: 'code' as const };

describe('a skill rule', () => {
  it('matches when each condition it names matches, one of its values each; it says why, by each condition', () => {
    expect(ruleMatch({ skill: 'iac', repos: ['octo/infra'] }, job)).toEqual(['repository octo/infra']);
    expect(ruleMatch({ skill: 'iac', repos: ['octo/site', 'octo/infra'], labels: ['iac'] }, job)).toEqual(['repository octo/infra', 'label iac']);
    expect(ruleMatch({ skill: 'iac', labels: ['gitops', 'iac'], kinds: ['code'] }, job)).toEqual(['label iac', 'kind of work code']);
    expect(ruleMatch({ skill: 'iac', repos: ['octo/infra'], labels: ['gitops'] }, job)).toBeUndefined();
    expect(ruleMatch({ skill: 'iac', kinds: ['research'] }, job)).toBeUndefined();
    expect(ruleMatch({ skill: 'iac', repos: ['octo/infra'] }, { kind: 'code' })).toBeUndefined();
  });

  it('names a skill and at least one condition, each a list of values', () => {
    expect(skillRuleProblem({ skill: 'iac', labels: ['iac'] })).toBeUndefined();
    expect(skillRuleProblem({ skill: 'iac' })).toMatch(/at least one condition/);
    expect(skillRuleProblem({ skill: 'Bad Name', labels: ['iac'] })).toMatch(/no skill name/);
    expect(skillRuleProblem({ skill: 'iac', repos: ['infra'] })).toMatch(/owner\/name/);
    // A GitLab project in a subgroup (issue #1924 part 4): its whole path.
    expect(skillRuleProblem({ skill: 'iac', repos: ['ops/platform/infra'] })).toBeUndefined();
    expect(ruleMatch({ skill: 'iac', repos: ['ops/platform/infra'] }, { ...job, repo: 'Ops/Platform/Infra' })).toEqual(['repository ops/platform/infra']);
    expect(skillRuleProblem({ skill: 'iac', kinds: ['deploy'] } as never)).toMatch(/kind of work/);
    expect(skillRuleProblem({ skill: 'iac', labels: [] })).toMatch(/at least one condition/);
  });

  it('a paths condition is not known at the start: the rule matches, and says the paths; the done check reads them later', () => {
    expect(ruleMatch({ skill: 'iac', paths: ['*.tf'] }, job)).toEqual(['paths *.tf']);
    expect(ruleMatch({ skill: 'iac', labels: ['iac'], paths: ['*.tf', 'modules/**'] }, job)).toEqual(['label iac', 'paths *.tf, modules/**']);
    expect(ruleMatch({ skill: 'iac', labels: ['gitops'], paths: ['*.tf'] }, job)).toBeUndefined();
    expect(skillRuleProblem({ skill: 'iac', paths: ['*.tf'] })).toBeUndefined();
    expect(skillRuleProblem({ skill: 'iac', paths: ['/abs/*.tf'] })).toMatch(/relative/);
    expect(patchWorkSkills({ kinds: {}, repos: {} }, { rules: [{ skill: 'iac', paths: ['*.tf'] }] }).rules).toEqual([{ skill: 'iac', paths: ['*.tf'] }]);
  });

  it('a paths condition applies when a changed file matches: a pattern with no slash matches the file name in any folder', () => {
    expect(pathsApply(undefined, { files: ['README.md'] })).toBe(true);
    expect(pathsApply(['*.tf'], { files: ['README.md', 'envs/prod/main.tf'] })).toBe(true);
    expect(pathsApply(['src/**'], { files: ['src/a/b.ts'] })).toBe(true);
    expect(pathsApply(['src/**'], { files: ['docs/src/x.md'] })).toBe(false);
    expect(pathsApply(['*.tf'], { files: ['README.md'] })).toBe(false);
    // Not known (no mirror), or not all files named: the criteria apply. Not known is not a pass.
    expect(pathsApply(['*.tf'], {})).toBe(true);
    expect(pathsApply(['*.tf'], { files: ['README.md'], filesCut: true })).toBe(true);
  });

  it('the work skill settings keep the rules; a change replaces them, and a skill a rule names cannot be removed', () => {
    const next = patchWorkSkills({ kinds: {}, repos: {} }, { rules: [{ skill: 'iac', repos: ['Octo/Infra'] }] });
    expect(next).toEqual({ kinds: {}, repos: {}, rules: [{ skill: 'iac', repos: ['octo/infra'] }] });
    expect(namedSkills(next)).toEqual(['iac']);
    expect(patchWorkSkills(next, { kinds: { code: 'work' } }).rules).toEqual([{ skill: 'iac', repos: ['octo/infra'] }]);
    expect(patchWorkSkills(next, { rules: [] })).toEqual({ kinds: {}, repos: {} });
  });
});

describe('a skill\'s done criteria', () => {
  const criteria: DoneCriterion[] = [{ kind: 'checks-passed', checks: 'terraform plan*' }, { kind: 'plan-destroy', checks: 'terraform plan*' }];

  it('are the done.json beside its SKILL.md; a skill with a done.json that is no list of criteria is refused', () => {
    expect(doneCriteriaOf({ 'SKILL.md': '# x' })).toEqual([]);
    expect(doneCriteriaOf({ 'SKILL.md': '# x', 'done.json': JSON.stringify({ criteria }) })).toEqual(criteria);
    expect(doneFileProblem('{')).toMatch(/done\.json is no JSON/);
    expect(doneFileProblem(JSON.stringify({ criteria: [{ kind: 'vibes' }] }))).toMatch(/done\.json/);
    expect(doneFileProblem(JSON.stringify({ criteria: [{ kind: 'checks-passed' }] }))).toMatch(/checks/);
    expect(doneFileProblem(JSON.stringify({ criteria: [{ kind: 'plan-destroy', max: -1 }] }))).toMatch(/max/);
    expect(skillFilesProblem({ 'SKILL.md': '# x', 'done.json': '[]' })).toMatch(/done\.json/);
    expect(skillFilesProblem({ 'SKILL.md': '# x', 'done.json': JSON.stringify({ criteria }) })).toBeUndefined();
  });

  it('a terraform plan\'s destroy count, from each Plan line; a replace is a destroy, no changes is none', () => {
    expect(planDestroys('Plan: 1 to add, 0 to change, 1 to destroy.\n')).toEqual([1]);
    expect(planDestroys('Plan: 2 to import, 1 to add, 3 to change, 0 to destroy.\nPlan: 0 to add, 0 to change, 4 to destroy.')).toEqual([0, 4]);
    expect(planDestroys('No changes. Your infrastructure matches the configuration.')).toEqual([0]);
    expect(planDestroys('## Plan summary\n\n**1** to destroy')).toEqual([]);
  });

  it('every check it names passed, and no plan destroys more than its limit; each miss said plainly', () => {
    const passed = { name: 'terraform plan (prod)', state: 'passing' as const, text: 'Plan: 1 to add, 0 to change, 0 to destroy.' };
    expect(unmetCriteria(criteria, { checks: [passed, { name: 'lint', state: 'failing' }], comments: [] })).toEqual([]);
    expect(unmetCriteria(criteria, { checks: [{ name: 'lint', state: 'passing' }], comments: [] })).toEqual([
      'no check named terraform plan* ran yet', 'no terraform plan summary in the checks named terraform plan* or the pull request\'s comments',
    ]);
    expect(unmetCriteria(criteria, {
      checks: [passed, { name: 'Terraform Plan (staging)', state: 'failing', text: 'Plan: 0 to add, 0 to change, 1 to destroy.' }, { name: 'terraform plan (dev)', state: 'pending' }], comments: [],
    })).toEqual(['check Terraform Plan (staging) is failing, terraform plan (dev) is pending', 'a terraform plan destroys or replaces 1 resource (Terraform Plan (staging)); at most 0 may be']);
    expect(unmetCriteria([{ kind: 'plan-destroy' }], { checks: [], comments: ['Plan: 0 to add, 1 to change, 2 to destroy.'] }))
      .toEqual(['a terraform plan destroys or replaces 2 resources (a comment); at most 0 may be']);
    expect(unmetCriteria([{ kind: 'plan-destroy', max: 2 }], { checks: [], comments: ['Plan: 0 to add, 1 to change, 2 to destroy.'] })).toEqual([]);
  });

  const replaces = [
    '  # module.deployment.module.bastion[0].aws_instance.bastion must be replaced',
    '-/+ resource "aws_instance" "bastion" {',
    '  # aws_s3_bucket.logs will be destroyed',
    '  # aws_iam_role.old (deposed object 1a2b3c4d) will be destroyed',
    '  # aws_instance.web is tainted, so must be replaced',
    '  # aws_instance.api will be updated in-place',
  ].join('\n');

  it('the addresses a plan destroys or replaces, from its resource lines', () => {
    expect(destroyedAddresses(replaces)).toEqual([
      'module.deployment.module.bastion[0].aws_instance.bastion', 'aws_s3_bucket.logs', 'aws_iam_role.old', 'aws_instance.web',
    ]);
    expect(destroyedAddresses('\u001b[1m  # aws_s3_bucket.logs\u001b[0m will be destroyed')).toEqual(['aws_s3_bucket.logs']);
  });

  it('the deletes an issue allows, by address: the list after an Allowed deletes line', () => {
    const body = [
      'Remove the old bucket.', '', '**Allowed deletes:** `aws_s3_bucket.logs`, `aws_iam_role.old`', '',
      '## Allowed deletes', '- `module.a.aws_instance.x[0]`', '* module.b.aws_db_instance.y', '', 'Not this: `aws_vpc.main`',
    ].join('\n');
    expect(allowedDeletesIn([body])).toEqual(['aws_s3_bucket.logs', 'aws_iam_role.old', 'module.a.aws_instance.x[0]', 'module.b.aws_db_instance.y']);
    expect(allowedDeletesIn(['Delete `aws_vpc.main` please.'])).toEqual([]);
  });

  it('a delete the issue allows by address does not count; any other, or one the plan text does not name, does', () => {
    const plan = (body: string, n: number) => `${body}\n\nPlan: 0 to add, 0 to change, ${n} to destroy.`;
    const one = plan('  # aws_s3_bucket.logs will be destroyed', 1);
    expect(unmetCriteria([{ kind: 'plan-destroy' }], { checks: [], comments: [one], allowed: ['aws_s3_bucket.logs'] })).toEqual([]);
    expect(unmetCriteria([{ kind: 'plan-destroy' }], { checks: [], comments: [one], allowed: ['aws_s3_bucket.other'] }))
      .toEqual(['a terraform plan destroys or replaces 1 resource (a comment): aws_s3_bucket.logs, which the issue does not allow; at most 0 may be']);
    // Two roots in one text: each plan's resource lines are the ones before its Plan line.
    const two = `${plan('  # aws_s3_bucket.logs will be destroyed', 1)}\n${plan('  # aws_instance.web must be replaced', 1)}`;
    expect(unmetCriteria([{ kind: 'plan-destroy' }], { checks: [], comments: [two], allowed: ['aws_s3_bucket.logs'] }))
      .toEqual(['a terraform plan destroys or replaces 1 resource (a comment): aws_instance.web, which the issue does not allow; at most 0 may be']);
    // A summary with no resource lines names no address: its deletes count.
    expect(unmetCriteria([{ kind: 'plan-destroy' }], { checks: [], comments: [plan('', 1)], allowed: ['aws_s3_bucket.logs'] }))
      .toEqual(['a terraform plan destroys or replaces 1 resource (a comment); at most 0 may be']);
  });

  it('as one line for the job\'s prompt', () => {
    expect(criteriaLine(criteria)).toBe('every check named terraform plan* passed; no terraform plan of the checks named terraform plan* destroys or replaces a resource');
    expect(criteriaLine([{ kind: 'plan-destroy', max: 1 }])).toBe('no terraform plan destroys or replaces more than 1 resource');
  });
});

describe('delivery', () => {
  const chosen: ConditionalSkillChosen[] = [{ name: 'iac', version: 'abc', seq: 0, why: ['label iac'], done: [{ kind: 'plan-destroy' }] }];

  it('one line after the job rules names each skill, why, and its done criteria; none, no line', () => {
    expect(withConditionalSkills('Be brief.', [])).toBe('Be brief.');
    expect(withConditionalSkills('Be brief.', chosen)).toMatch(/^Be brief\.\n\[hopper conditional skills\] .*iac, version abc \(label iac\)\. .*HOPPER_CONDITIONAL_SKILLS.*The hopper checks before the job is done: iac: no terraform plan destroys or replaces a resource\.$/);
  });

  it('a skill with paths says its criteria apply only when the change touches them', () => {
    const paths: ConditionalSkillChosen[] = [{ ...chosen[0]!, why: ['paths *.tf'], paths: ['*.tf'] }];
    expect(withConditionalSkills('', paths)).toMatch(/iac, version abc \(paths \*\.tf\)\. .*The hopper checks before the job is done: iac, when the change touches \*\.tf: no terraform plan/);
    expect(conditionalSkillsCredentials(paths, { iac: { 'SKILL.md': 'a' } }).files['conditional-skill/INDEX.md']).toMatch(/when the change touches \*\.tf/);
  });

  it('each skill\'s files go under conditional-skill/<name>, and an index the variable names lists them', () => {
    const c = conditionalSkillsCredentials(chosen, { iac: { 'SKILL.md': 'a', 'done.json': 'b' } });
    expect(c.paths).toEqual({ HOPPER_CONDITIONAL_SKILLS: 'conditional-skill/INDEX.md' });
    expect(c.files['conditional-skill/iac/SKILL.md']).toBe('a');
    expect(c.files['conditional-skill/iac/done.json']).toBe('b');
    expect(c.files['conditional-skill/INDEX.md']).toMatch(/iac\/SKILL\.md.*label iac/s);
    expect(conditionalSkillsCredentials([], {})).toEqual({ files: {}, paths: {} });
  });
});

describe('a person-merges criterion (issue #1924 part 3)', () => {
  const GITOPS: DoneCriterion[] = [{ kind: 'person-merges', paths: ['**/overlays/production/**'] }];

  it('is a valid done criterion, with or without paths; its paths are relative globs', () => {
    expect(doneFileProblem(JSON.stringify({ criteria: GITOPS }))).toBeUndefined();
    expect(doneFileProblem(JSON.stringify({ criteria: [{ kind: 'person-merges' }] }))).toBeUndefined();
    expect(doneFileProblem(JSON.stringify({ criteria: [{ kind: 'person-merges', paths: '*.yaml' }] }))).toMatch(/person-merges's "paths"/);
    expect(doneFileProblem(JSON.stringify({ criteria: [{ kind: 'person-merges', paths: ['../x/**'] }] }))).toMatch(/person-merges's "paths"/);
  });

  it("holds the hopper's merge of a change to its paths, or of one whose files are not known; never a done-check miss", () => {
    expect(mergeHolds(GITOPS, { files: ['apps/web/overlays/production/kustomization.yaml'] })).toEqual(['a person merges a change to **/overlays/production/**, not the hopper']);
    expect(mergeHolds(GITOPS, { files: ['apps/web/overlays/staging/kustomization.yaml'] })).toEqual([]);
    expect(mergeHolds(GITOPS, {})).toHaveLength(1);
    expect(mergeHolds(GITOPS, { files: ['a.yaml'], filesCut: true })).toHaveLength(1);
    expect(mergeHolds([{ kind: 'person-merges' }], { files: ['a.yaml'] })).toEqual(['a person merges it, not the hopper']);
    expect(mergeHolds([{ kind: 'plan-destroy' }], {})).toEqual([]);
    expect(unmetCriteria(GITOPS, { checks: [], comments: [] })).toEqual([]);
  });

  it('is said plainly in the prompt', () => {
    expect(criteriaLine(GITOPS)).toBe('a person merges a change to **/overlays/production/**, not the hopper');
  });

  it('the built-in gitops-deploy skill carries it', () => {
    const gitops = builtInSkills().find((s) => s.name === 'gitops-deploy');
    expect(gitops && doneFileProblem(gitops.files['done.json'] ?? '')).toBeUndefined();
    expect(doneCriteriaOf(gitops!.files).map((c) => c.kind)).toEqual(['person-merges']);
    expect(skillFilesProblem(gitops!.files)).toBeUndefined();
  });
});
