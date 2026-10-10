// Issue #652: git through the hopper — the parts. A job's git fetch and push go to the hopper, which does them on
// GitHub with its own connection; the job holds no GitHub token. What a push may change is read from the ref updates
// at the head of git's receive-pack request, before anything reaches GitHub. The whole path through the daemon, with a
// real git and a real git server, is test/integration/git-proxy.test.ts.
import { describe, expect, it } from 'vitest';
import { checkPush, gitPath, jobGitConfig, receivePackCommands } from '../../src/github-proxy/index.ts';
import { GITHUB_PROXY_LINE } from '../../src/job-rules/index.ts';

const ZERO = '0'.repeat(40);
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

const pkt = (s: string): string => `${(s.length + 4).toString(16).padStart(4, '0')}${s}`;
const request = (...lines: string[]): Buffer => Buffer.concat([Buffer.from(lines.map(pkt).join('') + '0000'), Buffer.from('PACK…')]);

describe('the ref updates of a push', () => {
  it('are read from the pkt-lines before the pack, the capabilities left off', () => {
    expect(receivePackCommands(request(`${A} ${B} refs/heads/issue-7-fast\0report-status side-band-64k`, `${ZERO} ${B} refs/heads/two\n`))).toEqual({
      ok: true, commands: [{ old: A, new: B, ref: 'refs/heads/issue-7-fast' }, { old: ZERO, new: B, ref: 'refs/heads/two' }],
    });
  });

  it('a signed push, a shallow line or text that is no pkt-line is not read', () => {
    expect(receivePackCommands(request(`push-cert\0report-status`))).toEqual({ ok: false, reason: 'a signed push (push-cert) is not taken' });
    expect(receivePackCommands(request(`shallow ${A}`, `${A} ${B} refs/heads/x\0report-status`))).toEqual({ ok: false, reason: 'a push from a shallow clone is not taken: fetch the full history first' });
    expect(receivePackCommands(Buffer.from('zzzz'))).toEqual({ ok: false, reason: 'not a git push' });
    expect(receivePackCommands(request())).toEqual({ ok: false, reason: 'the push names no ref' });
  });
});

describe('what a job may push', () => {
  const at = { defaultBranch: 'dev' };

  it('a branch of its own work: new, updated, or forced', () => {
    expect(checkPush([{ old: ZERO, new: B, ref: 'refs/heads/issue-7-fast' }], at)).toEqual({ ok: true });
    expect(checkPush([{ old: A, new: B, ref: 'refs/heads/issue-7-fast' }], at)).toEqual({ ok: true });
  });

  it('never the default branch, a release branch, a tag, or a delete', () => {
    for (const branch of ['dev', 'main', 'master', 'beta', 'stable', 'DEV']) {
      expect(checkPush([{ old: A, new: B, ref: `refs/heads/${branch}` }], at)).toEqual({ ok: false, reason: `a job pushes only to a branch of its own work, never to ${branch}: push a new branch and open a pull request` });
    }
    expect(checkPush([{ old: A, new: B, ref: 'refs/heads/trunk' }], { defaultBranch: 'trunk' })).toMatchObject({ ok: false });
    expect(checkPush([{ old: ZERO, new: B, ref: 'refs/tags/v1' }], at)).toEqual({ ok: false, reason: 'a job pushes branches only, not refs/tags/v1' });
    expect(checkPush([{ old: A, new: ZERO, ref: 'refs/heads/issue-7-fast' }], at)).toEqual({ ok: false, reason: 'a job deletes no branch (refs/heads/issue-7-fast)' });
    expect(checkPush([{ old: A, new: B, ref: 'refs/heads/ok' }, { old: A, new: B, ref: 'refs/heads/main' }], at)).toMatchObject({ ok: false });
  });
});

describe('the path of a git request', () => {
  it('names the repository and the git service, with or without .git', () => {
    expect(gitPath('octo/tools.git/info/refs', 'git-upload-pack')).toEqual({ repo: 'octo/tools', service: 'git-upload-pack', advertise: true });
    expect(gitPath('octo/tools/info/refs', 'git-receive-pack')).toEqual({ repo: 'octo/tools', service: 'git-receive-pack', advertise: true });
    expect(gitPath('octo/tools.git/git-receive-pack', undefined)).toEqual({ repo: 'octo/tools', service: 'git-receive-pack', advertise: false });
    expect(gitPath('octo/tools.git/info/refs', undefined)).toBeUndefined();
    expect(gitPath('octo/tools.git/objects/info/packs', undefined)).toBeUndefined();
    expect(gitPath('../etc/info/refs', 'git-upload-pack')).toBeUndefined();
  });
});

describe('the git config a job runs with', () => {
  it('sends every GitHub remote to the hopper, and answers git\'s credential ask from the job\'s token file', () => {
    expect(jobGitConfig('http://hopper:4790', 'https://github.com')).toEqual({
      GIT_CONFIG_COUNT: '5',
      GIT_CONFIG_KEY_0: 'url.http://hopper:4790/job/git/.insteadOf', GIT_CONFIG_VALUE_0: 'https://github.com/',
      GIT_CONFIG_KEY_1: 'url.http://hopper:4790/job/git/.insteadOf', GIT_CONFIG_VALUE_1: 'git@github.com:',
      GIT_CONFIG_KEY_2: 'url.http://hopper:4790/job/git/.insteadOf', GIT_CONFIG_VALUE_2: 'ssh://git@github.com/',
      GIT_CONFIG_KEY_3: 'credential.http://hopper:4790/job/git/.helper', GIT_CONFIG_VALUE_3: '',
      GIT_CONFIG_KEY_4: 'credential.http://hopper:4790/job/git/.helper',
      GIT_CONFIG_VALUE_4: '!f() { test "$1" = get || exit 0; echo username=hopper-job; printf \'password=%s\\n\' "$(cat "$HOPPER_TOKEN_FILE")"; }; f',
    });
  });
});

describe('what a job is told', () => {
  it('that its machine holds no GitHub token, and its git goes through the hopper by itself', () => {
    expect(GITHUB_PROXY_LINE).toContain('This machine holds no GitHub token: git fetch and git push to GitHub go through the hopper by themselves');
  });
});
