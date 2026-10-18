// Conditional skills (issue #1924): which library skills a job gets beside its work skill, by the skill rules — its
// repository, its labels, its kind of work —, why each one, and the done criteria the hopper checks before the job is done.
import { describe, expect, it } from 'vitest';
import {
  conditionalSkillsCredentials, criteriaLine, doneCriteriaOf, doneFileProblem, planDestroys, ruleMatch, skillRuleProblem, unmetCriteria,
  withConditionalSkills, type ConditionalSkillChosen, type DoneCriterion,
} from '../../src/domain/conditional-skills.ts';
import { namedSkills, patchWorkSkills, skillFilesProblem } from '../../src/domain/skill-library.ts';

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
    expect(skillRuleProblem({ skill: 'iac', kinds: ['deploy'] } as never)).toMatch(/kind of work/);
    expect(skillRuleProblem({ skill: 'iac', labels: [] })).toMatch(/at least one condition/);
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
      checks: [passed, { name: 'Terraform Plan (uat)', state: 'failing', text: 'Plan: 0 to add, 0 to change, 1 to destroy.' }, { name: 'terraform plan (dev)', state: 'pending' }], comments: [],
    })).toEqual(['check Terraform Plan (uat) is failing, terraform plan (dev) is pending', 'a terraform plan destroys or replaces 1 resource (Terraform Plan (uat)); at most 0 may be']);
    expect(unmetCriteria([{ kind: 'plan-destroy' }], { checks: [], comments: ['Plan: 0 to add, 1 to change, 2 to destroy.'] }))
      .toEqual(['a terraform plan destroys or replaces 2 resources (a comment); at most 0 may be']);
    expect(unmetCriteria([{ kind: 'plan-destroy', max: 2 }], { checks: [], comments: ['Plan: 0 to add, 1 to change, 2 to destroy.'] })).toEqual([]);
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

  it('each skill\'s files go under conditional-skill/<name>, and an index the variable names lists them', () => {
    const c = conditionalSkillsCredentials(chosen, { iac: { 'SKILL.md': 'a', 'done.json': 'b' } });
    expect(c.paths).toEqual({ HOPPER_CONDITIONAL_SKILLS: 'conditional-skill/INDEX.md' });
    expect(c.files['conditional-skill/iac/SKILL.md']).toBe('a');
    expect(c.files['conditional-skill/iac/done.json']).toBe('b');
    expect(c.files['conditional-skill/INDEX.md']).toMatch(/iac\/SKILL\.md.*label iac/s);
    expect(conditionalSkillsCredentials([], {})).toEqual({ files: {}, paths: {} });
  });
});
