// Issue #1448: a job source for each further connected account, so Intake lists the issues of its job repositories. It is
// the first account's configured `github-account` instance, copied, with `account` set and named for the account; never
// part of the plugins config.
//
// Feature: a job source for each further GitHub account
//   Scenario: each further key gets a copy of the first account's instance, named for it
//   Scenario: no GitHub intake configured, no source for a further account either
//   Scenario: an instance the config names already for the key, or by the name, is not doubled
//
// Feature: the GitLab account's source (issue #1448 part 2)
//   Scenario: while a GitLab account is attached, the hopper adds a gitlab-account instance, unless the config has one
import { describe, expect, it } from 'vitest';
import { furtherAccountSources, gitlabAccountSources } from '../../src/users/further-sources.ts';
import { githubAccountOptions, sameAccountWork } from '../../src/sources/config.ts';

const FIRST = { name: 'github-account', plugin: 'github-account', options: { label: 'hopper', pollSeconds: 30 } };

describe('a job source for each further GitHub account (issue #1448)', () => {
  it('copies the first account\'s instance for each further key, with its account and its own name', () => {
    expect(furtherAccountSources([FIRST, { name: 'direct', plugin: 'direct' }], ['github', 'github-2', 'github-5'])).toEqual([
      { name: 'github-account-2', plugin: 'github-account', options: { label: 'hopper', pollSeconds: 30, account: 'github-2' } },
      { name: 'github-account-5', plugin: 'github-account', options: { label: 'hopper', pollSeconds: 30, account: 'github-5' } },
    ]);
    expect(furtherAccountSources([FIRST], ['github'])).toEqual([]);
  });

  it('adds none when no GitHub intake is configured', () => {
    expect(furtherAccountSources([{ name: 'direct', plugin: 'direct' }], ['github', 'github-2'])).toEqual([]);
  });

  it('does not double an instance the config names for the key, or a name it uses', () => {
    const named = { name: 'work', plugin: 'github-account', options: { account: 'github-2' } };
    expect(furtherAccountSources([FIRST, named], ['github', 'github-2'])).toEqual([]);
    expect(furtherAccountSources([FIRST, { name: 'github-account-2', plugin: 'direct' }], ['github', 'github-2'])).toEqual([]);
  });

  it('reads the account option, the first by default, and two accounts never take the same work', () => {
    const first = githubAccountOptions.parse({}), further = githubAccountOptions.parse({ account: 'github-2' });
    expect(first.account).toBe('github');
    expect(further.account).toBe('github-2');
    expect(githubAccountOptions.safeParse({ account: 'gitlab' }).success).toBe(false);
    expect(sameAccountWork(first, further)).toBe(false);
    expect(sameAccountWork(further, githubAccountOptions.parse({ account: 'github-2' }))).toBe(true);
  });
});

describe('the GitLab account\'s source (issue #1448 part 2)', () => {
  it('is added while a GitLab account is attached, unless the plugins config has one', () => {
    expect(gitlabAccountSources([FIRST], false)).toEqual([]);
    expect(gitlabAccountSources([FIRST], true)).toEqual([{ name: 'gitlab-account', plugin: 'gitlab-account' }]);
    expect(gitlabAccountSources([FIRST, { name: 'mine', plugin: 'gitlab-account' }], true)).toEqual([]);
    expect(gitlabAccountSources([{ name: 'gitlab-account', plugin: 'direct' }], true)).toEqual([{ name: 'gitlab-account-source', plugin: 'gitlab-account' }]);
  });
});
