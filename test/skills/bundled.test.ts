// Issue #1909: bundled skills — the hopper's own files, named by a content hash, harness-neutral.
import { describe, expect, it } from 'vitest';
import { releaseOf } from '../../src/client/release.ts';
import { BUNDLED_SKILL_NAMES, bundledSkill, bundledText } from '../../src/skills/bundled.ts';
import { catalogText, SKILL_NAMES } from '../../src/skills/catalog.ts';
import { TASKS_LINE } from '../../src/job-rules/index.ts';

describe('bundled skills (issue #1909)', () => {
  it('a skill\'s version is the content hash of its files: the same files, the same version', () => {
    const s = bundledSkill('orchestrate');
    expect(s.version).toMatch(/^[0-9a-f]{16}$/);
    expect(s.version).toBe(releaseOf(s.files).id);
    expect(releaseOf({ ...s.files, 'SKILL.md': `${s.files['SKILL.md']!} ` }).id).not.toBe(s.version);
  });

  it('each is in the catalog and among the names a no lists', () => {
    for (const name of BUNDLED_SKILL_NAMES) {
      expect(catalogText()).toMatch(new RegExp(`^${name}: `, 'm'));
      expect(SKILL_NAMES).toContain(name);
    }
  });

  it('a load answers the entry headed by the version; a file it does not have is a no', () => {
    const s = bundledSkill('orchestrate');
    expect(bundledText(s)).toEqual({ text: `skill orchestrate, version ${s.version}\n\n${s.files['SKILL.md']!}` });
    expect(bundledText(s, 'other.md')).toEqual({ no: 'the skill orchestrate has no file other.md. It has: SKILL.md.' });
  });

  it('orchestrate maps onto the hopper\'s own model, for any agent CLI, and needs no workflow repository', () => {
    const text = bundledSkill('orchestrate').files['SKILL.md']!;
    for (const part of ['HOPPER_TASKS', 'HOPPER_WAITING', 'on: issue OWNER/NAME#N', '--required --key fanout-', '"replayed": true', 'Part of #N']) expect(text).toContain(part);
    for (const outside of ['orchestrate.sh', 'workflows/', '.agents/', 'journal', 'Claude Code', 'Task tool']) expect(text).not.toContain(outside);
    expect(TASKS_LINE).toContain('sh "$HOPPER_SKILL" orchestrate');
  });
});
