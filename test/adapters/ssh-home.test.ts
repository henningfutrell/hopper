// Issue #1154: a machine whose ssh session has no HOME (seen on a WSL machine) was offline with `its home is not an
// absolute path: ""`. Its home is then its user's, from the user database, and the work tree is made under it.
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { probeSsh } from '../../src/machines/index.ts';
import { testSshAuth } from '../support/ssh.ts';

const SSH = fileURLToPath(new URL('../herdr/fake-ssh-bin.mjs', import.meta.url));
chmodSync(SSH, 0o755);

describe('probeSsh: a session with no HOME', () => {
  let dir: string;
  const home = process.env.HOME;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jh-ssh-home-'));
    process.env.FAKE_HERDR_DIR = dir;
    process.env.HOME = '';
  });
  afterEach(() => {
    process.env.HOME = home;
    rmSync(dir, { recursive: true, force: true });
  });

  it('takes its user\'s home from the user database, and makes the work tree', async () => {
    // The fake ssh runs the command in a local shell, with this process's environment: HOME is empty there.
    const r = await probeSsh({ target: 'laptop', sshBin: SSH, controlDir: join(dir, 's'), auth: testSshAuth(join(dir, 'auth')), workTree: join(dir, 'tree') });
    expect(r.home).toBe(userInfo().homedir);
    expect(r).not.toHaveProperty('workTreeProblem');
  });
});
