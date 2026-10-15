// Change kinds (issue #1076): a pull request's diff says what kind of change it is — docs or comments only, tests only,
// low-risk code, code, or sensitive — by path and content rules, per repository; the kind says which gate its merge
// takes: merged when ready with no person, merged when ready only with yolo mode on, or merged only by a person.
import { describe, expect, it } from 'vitest';
import {
  changeRuleFor, classifyChange, contentNeeded, DEFAULT_CHANGE_RULE, mergesOnReady, ruleKey, type ChangeRule,
} from '../../src/domain/change-kinds.ts';

const rule = DEFAULT_CHANGE_RULE;

describe('classifying a change by its files', () => {
  it('docs only: Markdown and the docs directory', () => {
    expect(classifyChange(rule, ['README.md', 'docs/design.md', 'whats-new/12.md'], {})).toMatchObject({ kind: 'docs' });
  });

  it('agent instructions are no docs: AGENTS.md, CLAUDE.md and a skill are sensitive', () => {
    for (const f of ['AGENTS.md', 'sub/CLAUDE.md', 'src/skills/x/SKILL.md', '.claude/settings.json']) {
      expect(classifyChange(rule, ['README.md', f], {})?.kind, f).toBe('sensitive');
    }
  });

  it('sensitive paths: auth, secrets, migrations, sandbox, CI workflows, infra, dependencies', () => {
    for (const f of ['src/auth/realm.ts', 'src/secrets/sealer.ts', 'src/store/migrations-recent.ts', 'src/sandbox/box.ts',
      '.github/workflows/pr.yml', 'infra/main.tf', 'Dockerfile', 'package.json', 'package-lock.json', 'src/vault/system.ts']) {
      const c = classifyChange(rule, [f], {});
      expect(c?.kind, f).toBe('sensitive');
      expect(c?.why.join(' '), f).toContain(f);
    }
  });

  it('tests only: test files, read with their content', () => {
    expect(classifyChange(rule, ['test/a.test.ts', 'src/b.spec.ts'], { 'test/a.test.ts': ['expect(1).toBe(1);'], 'src/b.spec.ts': ['it()'] })).toMatchObject({ kind: 'tests' });
  });

  it('docs and tests together: tests; with code: code; the most severe file wins', () => {
    const lines = { 'test/a.test.ts': ['x'], 'src/c.ts': ['const a = 1;'] };
    expect(classifyChange(rule, ['README.md', 'test/a.test.ts'], lines)?.kind).toBe('tests');
    expect(classifyChange(rule, ['README.md', 'test/a.test.ts', 'src/c.ts'], lines)?.kind).toBe('code');
  });

  it('comment-only changes to code count as docs', () => {
    const c = classifyChange(rule, ['src/c.ts', 'scripts/x.py'], { 'src/c.ts': ['// a comment', ' * a doc line', '/** opens */', '', ' */'], 'scripts/x.py': ['# a comment'] });
    expect(c).toMatchObject({ kind: 'docs' });
    expect(c?.why.join(' ')).toContain('comments only');
  });

  it('a code line among comments is code', () => {
    expect(classifyChange(rule, ['src/c.ts'], { 'src/c.ts': ['// a comment', 'const a = 1;'] })?.kind).toBe('code');
  });

  it('sensitive content in code: a secret, a child process, eval', () => {
    for (const l of ['const password = read();', "import { exec } from 'node:child_process';", 'eval(text)']) {
      expect(classifyChange(rule, ['src/c.ts'], { 'src/c.ts': [l] })?.kind, l).toBe('sensitive');
    }
  });

  it('content rules do not read docs: a design note that names a secret stays docs', () => {
    expect(classifyChange(rule, ['docs/design.md'], { 'docs/design.md': ['the master key seals each secret'] })?.kind).toBe('docs');
  });

  it('low-risk paths: styles and images', () => {
    expect(classifyChange(rule, ['ui/src/index.css', 'site/logo.svg'], { 'ui/src/index.css': ['a { color: red; }'], 'site/logo.svg': 'binary' })?.kind).toBe('low_risk');
  });

  it('code whose content was not read is code, never lighter', () => {
    const c = classifyChange(rule, ['ui/src/index.css'], {});
    expect(c?.kind).toBe('code');
    expect(c?.why.join(' ')).toContain('not read');
  });

  it('no files: no kind', () => {
    expect(classifyChange(rule, [], {})).toBeUndefined();
  });

  it('names the rule that classified it', () => {
    expect(classifyChange(rule, ['README.md'], {})?.rule).toBe(ruleKey(rule));
    expect(ruleKey({ ...rule, docs: [] })).not.toBe(ruleKey(rule));
  });
});

describe('the content a classification needs', () => {
  it('only the files that are neither docs nor sensitive by path', () => {
    expect(contentNeeded(rule, ['README.md', 'src/c.ts', 'test/a.test.ts'])).toEqual(['src/c.ts', 'test/a.test.ts']);
  });

  it('none when a path already makes it sensitive', () => {
    expect(contentNeeded(rule, ['src/auth/x.ts', 'src/c.ts'])).toEqual([]);
  });
});

describe('per-repository rules', () => {
  it("a repository's rule replaces the default's lists it names, and its merge gates one by one", () => {
    const r = changeRuleFor({ default: { lowRisk: ['ui/**'] }, repos: { 'o/r': { sensitive: ['src/**'], merge: { sensitive: 'person' } } } }, 'O/R');
    expect(r.lowRisk).toEqual(['ui/**']);
    expect(r.sensitive).toEqual(['src/**']);
    expect(r.docs).toEqual(rule.docs);
    expect(r.merge).toEqual({ ...rule.merge, sensitive: 'person' });
    expect(changeRuleFor(undefined, 'o/r')).toEqual(rule);
  });

  it('a content rule is a regular expression, case-insensitive', () => {
    const r: ChangeRule = { ...rule, sensitiveContent: ['TOKEN_[A-Z]+'] };
    expect(classifyChange(r, ['src/c.ts'], { 'src/c.ts': ['const t = token_abc;'] })?.kind).toBe('sensitive');
  });
});

describe('the merge gate of a kind', () => {
  it('docs and low-risk merge when ready with no person, yolo mode on or off', () => {
    for (const kind of ['docs', 'low_risk'] as const) {
      expect(mergesOnReady(rule, false, kind)).toBe(true);
      expect(mergesOnReady(rule, true, kind)).toBe(true);
    }
  });

  it('tests, code and sensitive keep the full gates: only with yolo mode on', () => {
    for (const kind of ['tests', 'code', 'sensitive'] as const) {
      expect(mergesOnReady(rule, false, kind)).toBe(false);
      expect(mergesOnReady(rule, true, kind)).toBe(true);
    }
  });

  it('not classified: yolo mode decides, as before', () => {
    expect(mergesOnReady(rule, false, undefined)).toBe(false);
    expect(mergesOnReady(rule, true, undefined)).toBe(true);
  });

  it('a person gate: the hopper never merges, yolo mode or not', () => {
    const r: ChangeRule = { ...rule, merge: { ...rule.merge, sensitive: 'person' } };
    expect(mergesOnReady(r, true, 'sensitive')).toBe(false);
  });
});
