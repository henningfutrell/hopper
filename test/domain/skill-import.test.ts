// Importing a library skill from a GitHub repository (issue #1911), pure: which folder of a repository holds the skill, the
// files of that folder as GitHub's tree lists them, the name an import takes when none is given, and whether a version
// was imported.
import { describe, expect, it } from 'vitest';
import {
  importedName, importPathOf, SKILL_MAX_FILE, SKILL_MAX_FILES, skillTreeFiles, type LibrarySkillSource,
} from '../../src/domain/skill-library.ts';

describe('the folder of a repository that holds the skill', () => {
  it('drops the slashes at its ends; an empty path is the repository root', () => {
    expect(importPathOf('/skills/orchestrate/')).toEqual({ path: 'skills/orchestrate' });
    expect(importPathOf('')).toEqual({ path: '' });
    expect(importPathOf('.')).toEqual({ path: '' });
  });

  it('refuses a path that leaves the repository or has strange parts', () => {
    expect(importPathOf('skills/../secrets')).toHaveProperty('problem');
    expect(importPathOf('a b/c')).toHaveProperty('problem');
    expect(importPathOf('x'.repeat(300))).toHaveProperty('problem');
  });
});

describe('the files of the skill, as GitHub\'s tree of its folder lists them', () => {
  const blob = (path: string, size = 10) => ({ path, type: 'blob', sha: `sha-${path}`, size });

  it('takes each file under the folder, with its path in the skill; folders and submodules are no files', () => {
    expect(skillTreeFiles([blob('SKILL.md'), { path: 'scripts', type: 'tree', sha: 't' }, blob('scripts/run.sh'), { path: 'vendor', type: 'commit', sha: 'c' }]))
      .toEqual({ files: [{ path: 'SKILL.md', sha: 'sha-SKILL.md' }, { path: 'scripts/run.sh', sha: 'sha-scripts/run.sh' }] });
  });

  it('refuses a folder with no SKILL.md, too many files, or a file too large, before any file is read', () => {
    expect(skillTreeFiles([blob('README.md')])).toEqual({ problem: 'the folder has no SKILL.md' });
    const many = [blob('SKILL.md'), ...Array.from({ length: SKILL_MAX_FILES }, (_, i) => blob(`f${i}.md`))];
    expect(skillTreeFiles(many)).toHaveProperty('problem', expect.stringContaining(`at most ${SKILL_MAX_FILES} files`));
    expect(skillTreeFiles([blob('SKILL.md'), blob('big.bin', SKILL_MAX_FILE + 1)])).toHaveProperty('problem', expect.stringContaining('big.bin'));
  });
});

describe('the name of an imported skill', () => {
  it('is the folder\'s last part, else the repository\'s name, as a skill name', () => {
    expect(importedName('octo/workflows', 'skills/Orchestrate')).toBe('orchestrate');
    expect(importedName('octo/Workflow_Template', '')).toBe('workflow-template');
    expect(importedName('octo/x', 'skills/__')).toBe('x');
  });
});

describe('an imported version says where it came from', () => {
  it('names the repository, the folder, the ref it follows and the commit it was read at', () => {
    const source: LibrarySkillSource = { kind: 'imported', repo: 'octo/workflows', path: 'skills/orchestrate', ref: 'HEAD', commit: 'c'.repeat(40) };
    expect(source.kind).toBe('imported');
  });
});
