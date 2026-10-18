// Issue #1909: the library skills `hopper-skill` serves — one text with the skill library's built-in files, its version
// the library's, harness-neutral — and a repository's own copy of one, as a job reports it.
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { builtInSkills } from '../../src/skill-library/index.ts';
import { catalogText, SKILL_NAMES } from '../../src/skills/catalog.ts';
import { repoCopyOf, SERVED_SKILL_NAMES, servedSkill, servedText } from '../../src/skills/library.ts';
import { TASKS_LINE } from '../../src/job-rules/index.ts';

describe('library skills hopper-skill serves (issue #1909)', () => {
  it('each is the skill library\'s built-in skill of that name: one text, one version', () => {
    for (const name of SERVED_SKILL_NAMES) expect(servedSkill(name)).toEqual(builtInSkills().find((s) => s.name === name));
    expect(existsSync(new URL('../../src/skills/bundled', import.meta.url))).toBe(false);
  });

  it('each is in the catalog and among the names a no lists', () => {
    for (const name of SERVED_SKILL_NAMES) {
      expect(catalogText()).toMatch(new RegExp(`^${name}: `, 'm'));
      expect(SKILL_NAMES).toContain(name);
    }
  });

  it('a load answers the entry headed by the version; a file it does not have is a no', () => {
    const s = servedSkill('orchestrate');
    expect(servedText(s)).toEqual({ text: `skill orchestrate, version ${s.version}\n\n${s.files['SKILL.md']!}` });
    expect(servedText(s, 'other.md')).toEqual({ no: 'the skill orchestrate has no file other.md. It has: SKILL.md.' });
  });

  it('orchestrate maps onto the hopper\'s own model, for any agent CLI, and needs no workflow repository', () => {
    const text = servedSkill('orchestrate').files['SKILL.md']!;
    for (const part of ['HOPPER_TASKS', 'HOPPER_WAITING', 'on: issue OWNER/NAME#N', '--required --key fanout-', '"replayed": true', 'Part of #N', 'orchestrate --repo-copy']) expect(text).toContain(part);
    for (const outside of ['orchestrate.sh', 'journal', 'Claude Code', 'Task tool']) expect(text).not.toContain(outside);
    expect(TASKS_LINE).toContain('sh "$HOPPER_SKILL" orchestrate');
  });

  it('a repository copy is a folder path in the repository, its git tree and commit, and whether it has changes', () => {
    const tree = 'a'.repeat(40); const commit = 'b'.repeat(40);
    expect(repoCopyOf({ repoCopy: '.agents/skills/workflow-orchestrate/', tree, commit, changed: '1' })).toEqual({ path: '.agents/skills/workflow-orchestrate', tree, commit, changed: true });
    expect(repoCopyOf({ repoCopy: '', tree: 'c'.repeat(64), commit: 'd'.repeat(64) })).toEqual({ path: '.', tree: 'c'.repeat(64), commit: 'd'.repeat(64), changed: false });
    expect(repoCopyOf({})).toBeUndefined();
    for (const bad of [{ repoCopy: '../up', tree, commit }, { repoCopy: '/abs', tree, commit }, { repoCopy: 'a b', tree, commit }, { repoCopy: 'x', tree: 'nothex', commit }, { repoCopy: 'x', tree, commit: '' }, { repoCopy: 'x'.repeat(161), tree, commit }]) {
      expect(repoCopyOf(bad)).toEqual({ no: expect.stringContaining('repository copy') });
    }
  });
});
