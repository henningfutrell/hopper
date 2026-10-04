// Every secret comes from the runtime (issue #56, design.md "Secrets"): a secret named NAME is the
// environment variable NAME, or the file the variable NAME_FILE names (a mounted secret: container or
// orchestrator secrets, a service manager's credentials). The hopper keeps none itself.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimeSecrets } from '../../src/secrets/runtime.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
/** A mounted secret file holding `text`; its path. */
const mounted = (text: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'jh-secret-'));
  dirs.push(dir);
  const path = join(dir, 'secret');
  writeFileSync(path, text, { mode: 0o600 });
  return path;
};

describe('runtimeSecrets', () => {
  it('reads NAME from the environment', () => {
    expect(runtimeSecrets({ A_KEY: 'from-env' })('A_KEY')).toBe('from-env');
  });

  it('reads the file NAME_FILE names; one trailing newline is not part of the secret', () => {
    expect(runtimeSecrets({ A_KEY_FILE: mounted('from-file\n') })('A_KEY')).toBe('from-file');
    expect(runtimeSecrets({ A_KEY_FILE: mounted('-----BEGIN KEY-----\nabc\n-----END KEY-----\n') })('A_KEY'))
      .toBe('-----BEGIN KEY-----\nabc\n-----END KEY-----');
  });

  it('reads the file at every call: a secret the runtime rotates is used at once', () => {
    const path = mounted('one');
    const secret = runtimeSecrets({ A_KEY_FILE: path });
    expect(secret('A_KEY')).toBe('one');
    writeFileSync(path, 'two');
    expect(secret('A_KEY')).toBe('two');
  });

  it('neither set, or set empty: undefined', () => {
    expect(runtimeSecrets({})('A_KEY')).toBeUndefined();
    expect(runtimeSecrets({ A_KEY: '' })('A_KEY')).toBeUndefined();
    expect(runtimeSecrets({ A_KEY_FILE: mounted('') })('A_KEY')).toBeUndefined();
  });

  it('both NAME and NAME_FILE set: refused, naming both (never a silent choice)', () => {
    expect(() => runtimeSecrets({ A_KEY: 'x', A_KEY_FILE: mounted('y') })('A_KEY')).toThrow(/A_KEY and A_KEY_FILE are both set/);
  });

  it('a NAME_FILE that cannot be read: refused, naming the variable', () => {
    expect(() => runtimeSecrets({ A_KEY_FILE: '/nonexistent/secret' })('A_KEY')).toThrow(/A_KEY_FILE: cannot read/);
  });
});
