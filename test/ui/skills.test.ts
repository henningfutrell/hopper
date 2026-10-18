// The Skills page in the UI (ui/src/model/skills.ts, issue #1911), pure: where each library skill came from, which skill
// each kind of work gets and which setting chose it, which settings name a skill (so it cannot be removed), the files of a
// draft and what is wrong with them, and the line a job's timeline shows for the work skill it got.
import { describe, expect, it } from 'vitest';
import {
  draftFiles, draftProblem, draftRows, kindRows, KIND_LABEL, newSkillFiles, repoRows, settingsNaming, sourceLine, workSkillChosenLine,
} from '../../ui/src/model/skills.ts';
import type { SkillLibraryView } from '../../src/domain/skill-library.ts';

const view: SkillLibraryView = {
  skills: [
    { name: 'work', builtIn: true, description: 'Do the work.', latest: { name: 'work', version: 'a'.repeat(16), seq: 0, source: { kind: 'built-in' }, by: 'the hopper' }, versions: 1 },
    { name: 'deep-research', builtIn: false, description: 'Dig deep.', latest: { name: 'deep-research', version: 'b'.repeat(16), seq: 3, source: { kind: 'created' }, by: 'an admin', at: '2026-10-18T10:00:00.000Z' }, versions: 3 },
    { name: 'my-work', builtIn: false, description: 'Mine.', latest: { name: 'my-work', version: 'c'.repeat(16), seq: 1, source: { kind: 'duplicated', name: 'work', version: 'a'.repeat(16) }, by: 'an admin', at: '2026-10-18T11:00:00.000Z' }, versions: 1 },
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

describe('the work skill a job got, on its timeline', () => {
  it('names the skill, its version and which setting chose it', () => {
    expect(workSkillChosenLine({ kind: 'research', name: 'deep-research', version: 'b'.repeat(16), seq: 3, from: 'repo' }))
      .toBe(`research: deep-research ${'b'.repeat(8)} (version 3), by the repository's setting`);
    expect(workSkillChosenLine({ kind: 'code', name: 'work', version: 'a'.repeat(16), seq: 0, from: 'default' }))
      .toBe(`code: work ${'a'.repeat(8)} (built-in), by the default`);
  });
});
