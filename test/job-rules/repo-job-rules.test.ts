// The repository job rules (issue #1472 part 4): the config record `repo-job-rules`, a text per repository
// (`owner/name`) or per owner (`owner/*`), told to every job of that repository after the job rules. A job of no
// repository, or of one with none, is told nothing more.
import { describe, expect, it } from 'vitest';
import type { ConfigRecords } from '../../src/domain/ports.ts';
import { REPO_JOB_RULES, repoJobRulesFor, repoJobRulesProblem, repoJobRulesView, withRepoJobRules, writeRepoJobRules } from '../../src/job-rules/repo-rules.ts';

function records(initial?: unknown): ConfigRecords & { value: unknown } {
  const r = {
    value: initial,
    read: () => r.value,
    version: () => (r.value === undefined ? 'missing' : `v:${JSON.stringify(r.value)}`),
    write(_name: string, value: unknown, version: string) {
      if (version !== r.version()) return false;
      r.value = value;
      return true;
    },
  };
  return r as ConfigRecords & { value: unknown };
}

describe('the repository job rules', () => {
  it('is the record `repo-job-rules`', () => expect(REPO_JOB_RULES).toBe('repo-job-rules'));

  it('a job of no repository, or of one with none, is told nothing more', () => {
    expect(repoJobRulesFor(records(), 'acme/app')).toBe('');
    expect(repoJobRulesFor(records({ 'acme/app': 'Deploy to staging.' }), undefined)).toBe('');
    expect(repoJobRulesFor(records({ 'acme/app': 'Deploy to staging.' }), 'acme/other')).toBe('');
  });

  it('the owner\'s rules first, then the repository\'s, matched in any case', () => {
    const config = records({ 'Acme/App': 'Follow the change to qa in staging.', 'acme/*': 'Production stays with a person.' });
    expect(repoJobRulesFor(config, 'acme/app')).toBe([
      '[hopper repository rules] Rules set in the hopper for every job of acme/*:',
      'Production stays with a person.',
      '[hopper repository rules] Rules set in the hopper for every job of Acme/App:',
      'Follow the change to qa in staging.',
    ].join('\n'));
  });

  it('an empty text adds nothing', () => {
    expect(repoJobRulesFor(records({ 'acme/app': '  \n' }), 'acme/app')).toBe('');
  });

  it('a stored value that is not a map of texts is read as none', () => {
    expect(repoJobRulesFor(records('text'), 'acme/app')).toBe('');
    expect(repoJobRulesFor(records({ 'acme/app': 3 }), 'acme/app')).toBe('');
  });

  it('go after the job rules', () => {
    expect(withRepoJobRules('Be brief.', '')).toBe('Be brief.');
    expect(withRepoJobRules('Be brief.', 'R')).toBe('Be brief.\nR');
    expect(withRepoJobRules('', 'R')).toBe('R');
  });
});

describe('what may be saved', () => {
  it('a map of `owner/name` or `owner/*` to a text', () => {
    expect(repoJobRulesProblem({})).toBeUndefined();
    expect(repoJobRulesProblem({ 'acme/app': 'x', 'acme/*': 'y', 'a-b/c.d_e': 'z' })).toBeUndefined();
    expect(repoJobRulesProblem('x')).toBe('the repository job rules are a map of repository to text');
    expect(repoJobRulesProblem([])).toBe('the repository job rules are a map of repository to text');
    expect(repoJobRulesProblem({ 'acme/app': 3 })).toBe('the rules of acme/app are a text');
    expect(repoJobRulesProblem({ acme: 'x' })).toMatch(/acme is no repository: write owner\/name or owner\/\*/);
    expect(repoJobRulesProblem({ '*/*': 'x' })).toMatch(/is no repository/);
  });

  it('two names that differ only in case are refused', () => {
    expect(repoJobRulesProblem({ 'acme/app': 'x', 'ACME/app': 'y' })).toMatch(/ACME\/app and acme\/app name one repository/);
  });

  it('at most 16 KiB a repository, and at most 100 of them', () => {
    expect(repoJobRulesProblem({ 'acme/app': 'a'.repeat(16 * 1024) })).toBeUndefined();
    expect(repoJobRulesProblem({ 'acme/app': 'a'.repeat(16 * 1024 + 1) })).toMatch(/acme\/app may hold at most 16 KiB/);
    const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`acme/r${i}`, 'x']));
    expect(repoJobRulesProblem(many)).toBe('at most 100 repositories have rules; this has 101');
  });
});

describe('reading and writing them', () => {
  it('the view: each repository\'s rules, sorted, and the version', () => {
    expect(repoJobRulesView(records())).toEqual({ repos: [], version: 'missing' });
    expect(repoJobRulesView(records({ 'b/x': '2', 'a/*': '1' }))).toEqual({ repos: [{ repo: 'a/*', text: '1' }, { repo: 'b/x', text: '2' }], version: 'v:{"b/x":"2","a/*":"1"}' });
  });

  it('a write against the version read; a stale one is a conflict, an invalid one is refused', () => {
    const config = records();
    expect(writeRepoJobRules(config, { 'acme/app': 'x' }, 'missing')).toMatchObject({ ok: true, view: { repos: [{ repo: 'acme/app', text: 'x' }] } });
    expect(writeRepoJobRules(config, { 'acme/app': 'y' }, 'missing')).toMatchObject({ ok: false, code: 'conflict' });
    expect(writeRepoJobRules(config, { acme: 'y' }, config.version('repo-job-rules'))).toMatchObject({ ok: false, code: 'invalid' });
    expect(config.value).toEqual({ 'acme/app': 'x' });
  });
});
