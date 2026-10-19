// The skill library's pure rules (issue #1911): which skill a job of a kind of work gets — the repository's setting over
// the user's over the built-in default —, a change of the setting, and what a library skill's version may hold.
import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_SKILL_NAMES, DEFAULT_WORK_SKILL_SETTINGS, namedSkills, patchWorkSkills, SKILL_ALIASES, skillDescription, skillFilesProblem, skillNameOf, skillNameProblem, skillRequires, workKindOf,
  workSkillCredentials, workSkillFor, withWorkSkill, type WorkSkillSettings,
} from '../../src/domain/skill-library.ts';

const settings: WorkSkillSettings = { kinds: { code: 'careful' }, repos: { 'octo/site': { code: 'fast', research: 'deep' } } };

describe('the work skill a job gets', () => {
  it('the repository\'s setting, else the user\'s, else the built-in default; a repository matches whatever its case', () => {
    expect(workSkillFor(settings, 'Octo/Site', 'code')).toEqual({ name: 'fast', from: 'repo' });
    expect(workSkillFor(settings, 'octo/site', 'research')).toEqual({ name: 'deep', from: 'repo' });
    expect(workSkillFor(settings, 'octo/site', 'proposal')).toEqual({ name: 'proposal', from: 'default' });
    expect(workSkillFor(settings, 'octo/tools', 'code')).toEqual({ name: 'careful', from: 'user' });
    expect(workSkillFor(settings, undefined, 'code')).toEqual({ name: 'careful', from: 'user' });
    expect(workSkillFor(DEFAULT_WORK_SKILL_SETTINGS, 'octo/tools', 'research')).toEqual({ name: 'research', from: 'default' });
  });

  it('its kind of work: research, a proposal, else the work itself', () => {
    expect(workKindOf({ research: true })).toBe('research');
    expect(workKindOf({ proposal: true })).toBe('proposal');
    expect(workKindOf({})).toBe('code');
  });

  it('its line follows the job rules; its files go under work-skill/<name>, the variable names its SKILL.md', () => {
    const c = { kind: 'code' as const, name: 'careful', version: 'abc', seq: 2, from: 'user' as const };
    expect(withWorkSkill('Be brief.', c)).toMatch(/^Be brief\.\n\[hopper work skill\] .*\(code\) is careful, version abc\. When the variable HOPPER_WORK_SKILL is set/);
    expect(withWorkSkill('', c)).toMatch(/^\[hopper work skill\]/);
    expect(workSkillCredentials([{ name: 'careful', files: { 'SKILL.md': 'a', 'scripts/x.sh': 'b' } }])).toEqual({
      files: { 'work-skill/careful/SKILL.md': 'a', 'work-skill/careful/scripts/x.sh': 'b' }, paths: { HOPPER_WORK_SKILL: 'work-skill/careful/SKILL.md' },
    });
  });

  it('the skills it requires go beside it, each under work-skill/<name>; its line names them and the ones it could not get', () => {
    const c = { kind: 'code' as const, name: 'careful', version: 'abc', seq: 2, from: 'user' as const, requires: [{ name: 'orchestrate', version: 'def', seq: 0 }], missing: ['gone'] };
    expect(workSkillCredentials([{ name: 'careful', files: { 'SKILL.md': 'a' } }, { name: 'orchestrate', files: { 'SKILL.md': 'o' } }])).toEqual({
      files: { 'work-skill/careful/SKILL.md': 'a', 'work-skill/orchestrate/SKILL.md': 'o' }, paths: { HOPPER_WORK_SKILL: 'work-skill/careful/SKILL.md' },
    });
    const line = withWorkSkill('', c);
    expect(line).toContain('It requires orchestrate (version def): read its SKILL.md in ../orchestrate/ beside the work skill\'s directory when the work skill says to.');
    expect(line).toContain('The library has no skill gone that it requires: go on without it.');
    expect(withWorkSkill('', { ...c, requires: [], missing: [] })).not.toContain('requires');
  });
});

describe('the skills a skill requires', () => {
  it('its SKILL.md front matter\'s requires: a list in one line, in brackets, or one name a line; none without one', () => {
    expect(skillRequires('---\nname: a\nrequires: orchestrate, helper\n---\nbody')).toEqual(['orchestrate', 'helper']);
    expect(skillRequires('---\nname: a\nrequires: [orchestrate, "helper"]\n---\n')).toEqual(['orchestrate', 'helper']);
    expect(skillRequires('---\nname: a\nrequires:\n  - orchestrate\n  - helper\ndescription: x\n---\n')).toEqual(['orchestrate', 'helper']);
    expect(skillRequires('---\nrequires: helper, helper\n---\n')).toEqual(['helper']);
    expect(skillRequires('---\nname: a\n---\nrequires: not front matter')).toEqual([]);
    expect(skillRequires('no front matter')).toEqual([]);
  });

  it('a version names only skill names there, at most 8', () => {
    expect(skillFilesProblem({ 'SKILL.md': '---\nrequires: orchestrate\n---\n' })).toBeUndefined();
    expect(skillFilesProblem({ 'SKILL.md': '---\nrequires: Bad Name\n---\n' })).toMatch(/requires "Bad Name": no skill name/);
    expect(skillFilesProblem({ 'SKILL.md': `---\nrequires: ${Array.from({ length: 9 }, (_, i) => `s${i}`).join(', ')}\n---\n` })).toMatch(/requires at most 8 skills/);
  });
});

describe('a change of the setting', () => {
  it('sets each kind named, null to the next setting down; a repository with nothing left is dropped, lowercased', () => {
    const next = patchWorkSkills(settings, { kinds: { code: null, research: 'deep' }, repos: { 'Octo/Site': { code: null, research: null }, 'a/b': { proposal: 'p' } } });
    expect(next).toEqual({ kinds: { research: 'deep' }, repos: { 'a/b': { proposal: 'p' } } });
    expect(namedSkills(next).sort()).toEqual(['deep', 'p']);
    expect(settings.kinds).toEqual({ code: 'careful' });
  });
});

describe('a skill\'s other names (issue #2145)', () => {
  it('orchestrate is another name of the built-in work skill, no skill of its own; every other name is itself', () => {
    expect(SKILL_ALIASES).toEqual({ orchestrate: 'work' });
    expect(BUILT_IN_SKILL_NAMES).not.toContain('orchestrate');
    expect(skillNameOf('orchestrate')).toBe('work');
    for (const name of ['work', 'research', 'careful', 'constructor', 'toString']) expect(skillNameOf(name)).toBe(name);
  });
});

describe('a library skill\'s version', () => {
  it('a name of lowercase letters, digits and dashes', () => {
    expect(skillNameProblem('my-work-2')).toBeUndefined();
    for (const bad of ['', 'My', '-a', 'a b', 'a/b', 'x'.repeat(64)]) expect(skillNameProblem(bad), bad).toMatch(/no skill name/);
  });

  it('a SKILL.md; relative paths of plain parts, never ..; within the limits', () => {
    expect(skillFilesProblem({ 'SKILL.md': 'x', 'scripts/a.sh': 'y', 'assets/img/logo.svg': '<svg/>' })).toBeUndefined();
    expect(skillFilesProblem({ 'README.md': 'x' })).toMatch(/needs a SKILL.md/);
    for (const path of ['../x', '/etc/passwd', 'a/../b', '.hidden', 'a//b', 'a/b/c/d/e', 'a b']) expect(skillFilesProblem({ 'SKILL.md': 'x', [path]: 'y' }), path).toMatch(/no file path/);
    expect(skillFilesProblem({ 'SKILL.md': 'x'.repeat(64 * 1024 + 1) })).toMatch(/at most 64 KiB/);
    expect(skillFilesProblem(Object.fromEntries([['SKILL.md', 'x'], ...Array.from({ length: 32 }, (_, i) => [`f${i}.md`, 'y'])]))).toMatch(/at most 32 files/);
    expect(skillFilesProblem(Object.fromEntries([['SKILL.md', 'x'], ...Array.from({ length: 5 }, (_, i) => [`f${i}.md`, 'y'.repeat(60 * 1024)])]))).toMatch(/at most 256 KiB/);
  });

  it('its description: the front matter\'s, else its first heading or line', () => {
    expect(skillDescription('---\nname: a\ndescription: "Does a thing."\n---\n# A')).toBe('Does a thing.');
    expect(skillDescription('---\nname: a\n---\n\n# Careful work\nbody')).toBe('Careful work');
    expect(skillDescription('\nPlain first line\n')).toBe('Plain first line');
  });
});
