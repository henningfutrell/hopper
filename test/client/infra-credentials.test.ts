// Issue #1128 part 7: a machine must hold no infra credentials, so each machine's probe reads which infra credential folders
// (`.aws`, `.keycloak`, `.terraform.d`) are in its home: this machine and a client target with a read of the home, an ssh target
// with what INFRA_CREDENTIALS_COMMAND prints in its probe. Only the folder names, never what is in them.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INFRA_CREDENTIAL_FOLDERS, INFRA_CREDENTIALS_COMMAND, infraCredentialsAt, infraCredentialsOf, readInfraCredentials } from '../../src/client/infra-credentials.ts';

describe('infra credential folders', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'jh-infra-')); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('are .aws, .keycloak and .terraform.d', () => {
    expect([...INFRA_CREDENTIAL_FOLDERS]).toEqual(['.aws', '.keycloak', '.terraform.d']);
  });

  it('a home holds the ones that are there, folder or file, in the list\'s order; none: an empty list', () => {
    expect(infraCredentialsAt(home)).toEqual([]);
    mkdirSync(join(home, '.terraform.d'));
    writeFileSync(join(home, '.aws'), '');
    mkdirSync(join(home, '.kube'));
    expect(infraCredentialsAt(home)).toEqual(['.aws', '.terraform.d']);
  });

  it('the command an ssh target runs prints each one in its home; read back from the probe\'s other lines', () => {
    mkdirSync(join(home, '.keycloak'));
    mkdirSync(join(home, '.aws'));
    const out = execFileSync('sh', ['-c', `echo /home/x; ${INFRA_CREDENTIALS_COMMAND}; echo hopper-disk 1 2`], { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' });
    expect(readInfraCredentials(out)).toEqual(['.aws', '.keycloak']);
    expect(readInfraCredentials('/home/x\nhopper-disk 1 2\n')).toBeUndefined();
    const none = execFileSync('sh', ['-c', INFRA_CREDENTIALS_COMMAND], { env: { PATH: process.env.PATH, HOME: join(home, 'nothing') }, encoding: 'utf8' });
    expect(readInfraCredentials(none)).toEqual([]);
  });

  it('a client\'s answer is believed only for names on the list; anything else is not read', () => {
    expect(infraCredentialsOf(['.aws', '.terraform.d'])).toEqual(['.aws', '.terraform.d']);
    expect(infraCredentialsOf([])).toEqual([]);
    expect(infraCredentialsOf(['.aws', '/etc/passwd', 3])).toEqual(['.aws']);
    expect(infraCredentialsOf(undefined)).toBeUndefined();
    expect(infraCredentialsOf('.aws')).toBeUndefined();
  });
});
