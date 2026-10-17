// hopper.io's config from the runtime (issue #463): a missing or wrong value stops it at start; the hosted app's client
// secret comes as the variable or the file `<name>_FILE` names. And the seam: nothing in src/ imports cloud/, and
// cloud/ imports from src/ only the GitHub sign-in it shares with an instance and the runtime's secrets.
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cloudConfig } from '../../cloud/config.ts';

const ENV = {
  HOPPER_IO_DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/hopper_io', HOPPER_IO_PUBLIC_URL: 'https://hopper.example',
  HOPPER_IO_GITHUB_CLIENT_ID: 'hosted-app', HOPPER_IO_GITHUB_CLIENT_SECRET: 's3cret',
};

describe('hopper.io config', () => {
  it('reads the runtime, with GitHub, the host and the port defaulted', () => {
    expect(cloudConfig(ENV)).toEqual({
      databaseUrl: ENV.HOPPER_IO_DATABASE_URL, publicUrl: 'https://hopper.example', githubUrl: 'https://github.com',
      clientId: 'hosted-app', clientSecret: 's3cret', host: '127.0.0.1', port: 8080, trustProxy: false,
    });
  });

  it('takes the client secret from the file HOPPER_IO_GITHUB_CLIENT_SECRET_FILE names', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'hopper-io-')), 'secret');
    writeFileSync(file, 'from-file\n');
    const { HOPPER_IO_GITHUB_CLIENT_SECRET: _s, ...rest } = ENV;
    expect(cloudConfig({ ...rest, HOPPER_IO_GITHUB_CLIENT_SECRET_FILE: file }).clientSecret).toBe('from-file');
  });

  it.each([
    ['HOPPER_IO_DATABASE_URL', undefined, /HOPPER_IO_DATABASE_URL is not set/],
    ['HOPPER_IO_DATABASE_URL', 'mysql://x', /must be postgres/],
    ['HOPPER_IO_PUBLIC_URL', 'http://hopper.example', /must be https/],
    ['HOPPER_IO_PUBLIC_URL', 'https://hopper.example/app', /must be an origin/],
    ['HOPPER_IO_GITHUB_CLIENT_ID', undefined, /HOPPER_IO_GITHUB_CLIENT_ID is not set/],
    ['HOPPER_IO_GITHUB_CLIENT_SECRET', undefined, /HOPPER_IO_GITHUB_CLIENT_SECRET \(or HOPPER_IO_GITHUB_CLIENT_SECRET_FILE\) is not set/],
    ['HOPPER_IO_PORT', 'eighty', /must be a port number/],
  ])('%s=%s stops it', (name, value, error) => {
    expect(() => cloudConfig({ ...ENV, [name]: value })).toThrow(error);
  });

  it('http only on loopback', () => {
    expect(cloudConfig({ ...ENV, HOPPER_IO_PUBLIC_URL: 'http://127.0.0.1:8080' }).publicUrl).toBe('http://127.0.0.1:8080');
  });
});

const tsFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true, recursive: true })
  .filter((e) => e.isFile() && e.name.endsWith('.ts')).map((e) => join(e.parentPath, e.name));
const imports = (file: string): string[] => [...readFileSync(file, 'utf8').matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]!);

describe('the cloud/ seam (docs/design.md "Directories and what each must not know")', () => {
  it('nothing in src/ imports cloud/', () => {
    const cloud = resolve('cloud') + sep;
    const offenders = tsFiles('src').filter((f) => imports(f).some((i) => i.startsWith('.') && resolve(dirname(f), i).startsWith(cloud)));
    expect(offenders).toEqual([]);
  });

  it('cloud/ imports from src/ only the shared GitHub sign-in, the grant deletion and the runtime secrets', () => {
    const allowed = ['../src/connected-accounts/hopper-app.ts', '../src/connected-accounts/identity.ts', '../src/connected-accounts/revocation.ts', '../src/connected-accounts/web-flow.ts', '../src/secrets/runtime.ts'];
    const used = tsFiles('cloud').flatMap((f) => imports(f)).filter((i) => i.startsWith('../src/'));
    expect(used.filter((i) => !allowed.includes(i))).toEqual([]);
  });
});
