// The Skills page in the UI (ui/src/model/skills.ts, issue #1911), pure: where each library skill came from, which skill
// each kind of work gets and which setting chose it, which settings name a skill (so it cannot be removed), the files of a
// draft and what is wrong with them, and the line a job's timeline shows for the work skill it got.
import { describe, expect, it } from 'vitest';
import {
  draftFiles, draftProblem, draftRows, kindRows, KIND_LABEL, newSkillFiles, repoRows, requiresLine, ruleLine, settingsNaming, skillLoadedLine, sourceLine, workSkillChosenLine,
  conditionalSkillsChosenLine,
} from '../../ui/src/model/skills.ts';
import type { SkillLibraryView } from '../../src/domain/skill-library.ts';

const view: SkillLibraryView = {
  skills: [
    { name: 'work', builtIn: true, description: 'Do the work.', latest: { name: 'work', version: 'a'.repeat(16), seq: 0, source: { kind: 'built-in' }, by: 'the hopper' }, versions: 1, requires: ['deep-research', 'gone'] },
    { name: 'deep-research', builtIn: false, description: 'Dig deep.', latest: { name: 'deep-research', version: 'b'.repeat(16), seq: 3, source: { kind: 'created' }, by: 'an admin', at: '2026-10-18T10:00:00.000Z' }, versions: 3, requires: [] },
    { name: 'my-work', builtIn: false, description: 'Mine.', latest: { name: 'my-work', version: 'c'.repeat(16), seq: 1, source: { kind: 'duplicated', name: 'work', version: 'a'.repeat(16) }, by: 'an admin', at: '2026-10-18T11:00:00.000Z' }, versions: 1, requires: [] },
  ],
  workSkills: { kinds: { research: 'deep-research' }, repos: { 'octo/site': { code: 'my-work' }, 'octo/api': { research: 'deep-research', proposal: 'my-work' } } },
  defaults: { code: 'work', research: 'research', proposal: 'proposal' },
  kinds: ['code', 'research', 'proposal'],
};

describe('where a skill came from', () => {
  it('names a built-in skill, a skill a person wrote, and a copy with the version it copied', () => {
    expect(sourceLine(view.skills[0]!.latest)).toBe('built-in');
    expect(sourceLine(view.skills[1]!.latest)).toBe('written by an admin');
    expect(sourceLine(view.skills[2]!.latest)).toBe(`a copy of work ${'a'.repeat(8)}, by an admin`);
    const imported = { kind: 'imported' as const, repo: 'octo/workflows', path: 'skills/orchestrate', ref: 'HEAD', commit: 'c'.repeat(40) };
    expect(sourceLine({ source: imported, by: 'an admin' })).toBe(`imported from octo/workflows/skills/orchestrate at HEAD ${'c'.repeat(8)}, by an admin`);
    expect(sourceLine({ source: { ...imported, path: '', ref: 'dev' }, by: 'an admin' })).toBe(`imported from octo/workflows at dev ${'c'.repeat(8)}, by an admin`);
  });
});

describe('the skill of each kind of work', () => {
  it('shows each kind, the skill its setting names, else the built-in default', () => {
    expect(kindRows(view)).toEqual([
      { kind: 'code', label: KIND_LABEL.code, setting: undefined, gets: 'work', from: 'default' },
      { kind: 'research', label: KIND_LABEL.research, setting: 'deep-research', gets: 'deep-research', from: 'user' },
      { kind: 'proposal', label: KIND_LABEL.proposal, setting: undefined, gets: 'proposal', from: 'default' },
    ]);
  });

  it('lists each repository with its own choice, sorted', () => {
    expect(repoRows(view)).toEqual([
      { repo: 'octo/api', choice: { research: 'deep-research', proposal: 'my-work' } },
      { repo: 'octo/site', choice: { code: 'my-work' } },
    ]);
  });

  it('says which settings name a skill, so the page says why it cannot be removed', () => {
    expect(settingsNaming(view, 'my-work')).toEqual(['octo/api: Proposals', 'octo/site: Code work']);
    expect(settingsNaming(view, 'deep-research')).toEqual(['every repository: Research', 'octo/api: Research']);
    expect(settingsNaming(view, 'work')).toEqual([]);
  });
});

describe('a draft of a skill', () => {
  it('starts a new skill with a SKILL.md that names it', () => {
    const files = newSkillFiles('triage');
    expect(Object.keys(files)).toEqual(['SKILL.md']);
    expect(files['SKILL.md']).toMatch(/^---\nname: triage\ndescription: /);
  });

  it('turns files into rows, SKILL.md first, and back', () => {
    const rows = draftRows({ 'scripts/run.sh': 'echo', 'SKILL.md': '# x' });
    expect(rows.map((r) => r.path)).toEqual(['SKILL.md', 'scripts/run.sh']);
    expect(draftFiles(rows)).toEqual({ 'SKILL.md': '# x', 'scripts/run.sh': 'echo' });
  });

  it('says what is wrong: no name, no SKILL.md, an empty or a second path, a path with ..', () => {
    const ok = draftRows({ 'SKILL.md': '# x' });
    expect(draftProblem('triage', ok)).toBeUndefined();
    expect(draftProblem('Triage!', ok)).toMatch(/lowercase letters, digits and dashes/);
    expect(draftProblem('triage', draftRows({ 'notes.md': 'x' }))).toMatch(/needs a SKILL\.md/);
    expect(draftProblem('triage', [...ok, { path: ' ', text: '' }])).toMatch(/every file needs a path/);
    expect(draftProblem('triage', [...ok, { path: 'SKILL.md', text: '' }])).toMatch(/SKILL\.md is there twice/);
    expect(draftProblem('triage', [...ok, { path: '../x', text: '' }])).toMatch(/no file path in a skill/);
  });
});

describe('a skill the job loaded, on its timeline (issue #1909)', () => {
  it('names the skill, its version, and the repository\'s own copy the job follows', () => {
    expect(skillLoadedLine({ skill: 'kube', asset: 'cluster/prod' })).toBe('loaded kube for cluster/prod');
    expect(skillLoadedLine({ skill: 'orchestrate', version: 'a'.repeat(16) })).toBe(`loaded orchestrate ${'a'.repeat(8)}`);
    expect(skillLoadedLine({ skill: 'orchestrate', version: 'a'.repeat(16), asset: 'notes.md' })).toBe(`loaded orchestrate ${'a'.repeat(8)}, file notes.md`);
    expect(skillLoadedLine({ skill: 'orchestrate', version: 'a'.repeat(16), repoCopy: { path: '.agents/skills/workflow-orchestrate', tree: 'b'.repeat(40), commit: 'c'.repeat(40), changed: true } }))
      .toBe(`follows the repository's own orchestrate at .agents/skills/workflow-orchestrate (tree ${'b'.repeat(8)}, commit ${'c'.repeat(8)}, with changes), not the hopper's ${'a'.repeat(8)}`);
  });
});

describe('the work skill a job got, on its timeline', () => {
  it('names the skill, its version and which setting chose it', () => {
    expect(workSkillChosenLine({ kind: 'research', name: 'deep-research', version: 'b'.repeat(16), seq: 3, from: 'repo' }))
      .toBe(`research: deep-research ${'b'.repeat(8)} (version 3), by the repository's setting`);
    expect(workSkillChosenLine({ kind: 'code', name: 'work', version: 'a'.repeat(16), seq: 0, from: 'default' }))
      .toBe(`code: work ${'a'.repeat(8)} (built-in), by the default`);
  });

  it('names the skills it got beside it, and the ones the library did not have', () => {
    expect(workSkillChosenLine({ kind: 'code', name: 'work', version: 'a'.repeat(16), seq: 0, from: 'default', requires: [{ name: 'orchestrate', version: 'c'.repeat(16), seq: 0 }], missing: ['gone'] }))
      .toBe(`code: work ${'a'.repeat(8)} (built-in), by the default; with orchestrate ${'c'.repeat(8)}; not in the library: gone`);
  });
});

describe('the skills a skill requires', () => {
  it('names each one, and says which the library does not have; none: no line', () => {
    expect(requiresLine(view, view.skills[0]!)).toBe('requires deep-research, gone (not in the library)');
    expect(requiresLine(view, view.skills[1]!)).toBeUndefined();
  });
});

describe('conditional skills (issue #1924)', () => {
  it('a skill rule names a skill for removal, and reads as one line', () => {
    const rules = { ...view, workSkills: { ...view.workSkills, rules: [{ skill: 'my-work', repos: ['octo/infra'], labels: ['iac', 'gitops'] }] } };
    expect(settingsNaming(rules, 'my-work')).toContain('a skill rule: repository octo/infra and label iac or gitops');
    expect(ruleLine({ skill: 'iac', kinds: ['code'] })).toBe('kind of work Code work');
  });

  it('the job\'s timeline names each conditional skill it got, its version, why, and what the hopper checks', () => {
    expect(conditionalSkillsChosenLine({ skills: [
      { name: 'iac', version: 'd'.repeat(16), seq: 0, why: ['repository octo/infra', 'label iac'], done: [{ kind: 'plan-destroy' }] },
      { name: 'gitops', version: 'e'.repeat(16), seq: 2, why: ['label gitops'], done: [] },
    ] })).toBe(`conditional skills: iac ${'d'.repeat(8)} (built-in), by repository octo/infra, label iac; done when no terraform plan destroys or replaces a resource; gitops ${'e'.repeat(8)} (version 2), by label gitops`);
    // Part 3: a person-merges criterion.
    expect(conditionalSkillsChosenLine({ skills: [
      { name: 'gitops-deploy', version: 'f'.repeat(16), seq: 0, why: ['label gitops'], done: [{ kind: 'person-merges', paths: ['**/overlays/production/**'] }] },
    ] })).toBe(`conditional skills: gitops-deploy ${'f'.repeat(8)} (built-in), by label gitops; done when a person merges a change to **/overlays/production/**, not the hopper`);
  });
});
