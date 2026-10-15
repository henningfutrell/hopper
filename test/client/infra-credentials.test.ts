// Issues #1128 part 7, #1248: a machine's job user must hold no credentials, so each machine's probe reads which well-known
// credential places its job user's context holds — cloud CLI config, kube config, git credentials and helpers, ssh keys, and
// token variables: this machine and a client target with a read of the home and the environment, an ssh target with what
// INFRA_CREDENTIALS_COMMAND prints in its probe. Only the names, never a value.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INFRA_CREDENTIALS, INFRA_CREDENTIALS_COMMAND, infraCredentialsAt, infraCredentialsOf, readInfraCredentials } from '../../src/client/infra-credentials.ts';

describe('infra credentials', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'jh-infra-')); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('name cloud CLI config, kube config, git credentials, ssh keys and token variables', () => {
    for (const n of ['.aws', '.azure', '.config/gcloud', '.kube', '.keycloak', '.terraform.d', '.git-credentials', '.config/gh/hosts.yml', '.netrc', '.ssh/id_ed25519', '.ssh/id_rsa', 'git credential helper', '$AWS_ACCESS_KEY_ID', '$GH_TOKEN', '$KUBECONFIG']) {
      expect(INFRA_CREDENTIALS).toContain(n);
    }
  });

  it('a home holds the ones that are there, folder or file, in the list\'s order; none: an empty list', () => {
    expect(infraCredentialsAt(home, {})).toEqual([]);
    mkdirSync(join(home, '.terraform.d'));
    writeFileSync(join(home, '.aws'), '');
    mkdirSync(join(home, '.kube'));
    mkdirSync(join(home, '.ssh'));
    writeFileSync(join(home, '.ssh/id_ed25519'), '');
    writeFileSync(join(home, '.ssh/id_ed25519.pub'), '');
    writeFileSync(join(home, '.ssh/authorized_keys'), '');
    expect(infraCredentialsAt(home, {})).toEqual(['.aws', '.kube', '.terraform.d', '.ssh/id_ed25519']);
  });

  it('a git credential helper in its git config counts; another git setting does not', () => {
    writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = x\n');
    expect(infraCredentialsAt(home, {})).toEqual([]);
    writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = x\n[credential]\n\thelper = store\n');
    expect(infraCredentialsAt(home, {})).toEqual(['git credential helper']);
    rmSync(join(home, '.gitconfig'));
    mkdirSync(join(home, '.config/git'), { recursive: true });
    writeFileSync(join(home, '.config/git/config'), '[credential "https://example.com"]\n  Helper = manager\n');
    expect(infraCredentialsAt(home, {})).toEqual(['git credential helper']);
  });

  it('a token variable in the environment counts by its name; an empty one and any other do not', () => {
    expect(infraCredentialsAt(home, { GH_TOKEN: 'x', KUBECONFIG: '/k', PATH: '/bin', AWS_SESSION_TOKEN: '' })).toEqual(['$KUBECONFIG', '$GH_TOKEN']);
  });

  it('the command an ssh target runs prints each one there; read back from the probe\'s other lines, never a value', () => {
    mkdirSync(join(home, '.keycloak'));
    mkdirSync(join(home, '.aws'));
    mkdirSync(join(home, '.ssh'));
    writeFileSync(join(home, '.ssh/id_rsa'), '');
    const out = execFileSync('sh', ['-c', `echo /home/x; ${INFRA_CREDENTIALS_COMMAND}; echo hopper-disk 1 2`], { env: { PATH: process.env.PATH, HOME: home, GITHUB_TOKEN: 'never-printed' }, encoding: 'utf8' });
    expect(out).not.toContain('never-printed');
    expect(readInfraCredentials(out)).toEqual(['.aws', '.keycloak', '.ssh/id_rsa', '$GITHUB_TOKEN']);
    expect(readInfraCredentials('/home/x\nhopper-disk 1 2\n')).toBeUndefined();
    const none = execFileSync('sh', ['-c', INFRA_CREDENTIALS_COMMAND], { env: { PATH: process.env.PATH, HOME: join(home, 'nothing') }, encoding: 'utf8' });
    expect(readInfraCredentials(none)).toEqual([]);
  });

  it('the ssh command finds a git credential helper in the global git config', () => {
    writeFileSync(join(home, '.gitconfig'), '[credential]\n\thelper = store\n');
    const out = execFileSync('sh', ['-c', INFRA_CREDENTIALS_COMMAND], { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' });
    expect(readInfraCredentials(out)).toEqual(['git credential helper']);
  });

  it('a client\'s answer is believed only for names on the list; anything else is not read', () => {
    expect(infraCredentialsOf(['.aws', '.terraform.d'])).toEqual(['.aws', '.terraform.d']);
    expect(infraCredentialsOf([])).toEqual([]);
    expect(infraCredentialsOf(['.aws', '/etc/passwd', 3, '$GH_TOKEN'])).toEqual(['.aws', '$GH_TOKEN']);
    expect(infraCredentialsOf(undefined)).toBeUndefined();
    expect(infraCredentialsOf('.aws')).toBeUndefined();
  });
});
