// The origin of a GitLab issue (issue #1448 part 3, design.md "Jobs through GitLab"), pure: the acts it is judged by — who
// wrote it, who added the label last, who assigned it to the account last, who edited its title or description — and why
// they are not of a trusted origin, as Access answered for each GitLab user.
//
// Feature: a GitLab issue's origin
//   Scenario: the acts are read from the issue, its label events and GitLab's system notes, in each form GitLab writes them
//   Scenario: an act GitLab does not say who did, or of a user Access does not trust, is a reason; trusted acts are none
import { describe, expect, it } from 'vitest';
import { gitlabActs, untrustedActs } from '../../src/gitlab/origin.ts';
import { gitlabCloneUrl } from '../../src/domain/gitlab-account.ts';

const ada = { account: 'ada', userId: 7 }, bob = { account: 'bob', userId: 8 };

describe('the acts of a GitLab issue (issue #1448 part 3)', () => {
  it('are its author, the last who added the label, the last who assigned it to the account, and each edit of its text', () => {
    const acts = gitlabActs({ author: 'ada', authorId: 7 }, [
      { action: 'add', label: 'hopper', ...bob }, { action: 'remove', label: 'hopper', ...ada }, { action: 'add', label: 'Hopper', ...ada }, { action: 'add', label: 'bug', ...bob },
    ], [
      { body: 'assigned to @bob', ...bob },
      { body: 'assigned to @Ada and unassigned @bob', ...ada },
      { body: 'assigned to @carol and @ada', ...bob },
      { body: 'changed title from **x** to **y**', ...ada },
      { body: 'changed the description', ...bob },
      { body: 'mentioned in merge request !3', ...bob },
    ], 'hopper', 'ada');
    expect(acts).toEqual([
      { role: 'author', ...ada }, { role: 'labelled', ...ada }, { role: 'assigned', ...bob }, { role: 'edited', ...ada }, { role: 'edited', ...bob },
    ]);
  });

  it('say no one did an act GitLab does not show', () => {
    expect(gitlabActs({ author: 'ada' }, [], [], 'hopper', 'ada')).toEqual([{ role: 'author', account: 'ada' }, { role: 'labelled' }, { role: 'assigned' }]);
  });
});

describe('why acts are not of a trusted origin (issue #1448 part 3)', () => {
  it('names each act of a user Access does not trust, or that GitLab does not say who did; trusted acts give none', () => {
    const trusted = new Map([[7, true], [8, false]]);
    expect(untrustedActs([{ role: 'author', ...ada }, { role: 'labelled', ...ada }, { role: 'assigned', ...ada }], trusted)).toEqual([]);
    expect(untrustedActs([{ role: 'author', ...ada }, { role: 'labelled' }, { role: 'edited', ...bob }, { role: 'edited', ...bob }, { role: 'assigned', userId: 9 }], trusted)).toEqual([
      'GitLab does not say who added the label',
      'bob edited its title or description, and is not a trusted actor',
      'GitLab user 9 assigned it, and is not a trusted actor',
    ]);
  });
});

describe('the clone URL of a GitLab issue\'s project (issue #1448 part 3)', () => {
  it('is its project\'s URL on its GitLab, with any subgroups; nothing for another URL', () => {
    expect(gitlabCloneUrl('https://gitlab.example/acme/platform/api/-/issues/9')).toBe('https://gitlab.example/acme/platform/api.git');
    expect(gitlabCloneUrl('https://host.example/gitlab/ada/tools/-/issues/1')).toBe('https://host.example/gitlab/ada/tools.git');
    expect(gitlabCloneUrl('https://github.com/ada/tools/issues/1')).toBeUndefined();
    expect(gitlabCloneUrl('https://gitlab.example/ada/tools/-/issues/1/notes')).toBeUndefined();
  });
});
