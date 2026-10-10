// Issue #698: an ssh target's probe asks the machine which of the hopper's addresses it reaches. The source carries the
// one found, or the address problem, on the machine's snapshot and in the log. The fake ssh runs the command in a local
// shell, so the machine's curl is this one's, against servers on loopback.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAttachedMachineSource, probeSsh } from '../../src/machines/index.ts';
import { testSshAuth } from '../support/ssh.ts';

const SSH = fileURLToPath(new URL('../herdr/fake-ssh-bin.mjs', import.meta.url));
chmodSync(SSH, 0o755);

const flush = () => new Promise((r) => setImmediate(r));

describe('attached machine source', () => {
  // Issue #698: where its jobs reach the hopper, or why they cannot, said on the machine and in the log.
  it('its snapshot carries the hopper URL its probe found, or its address problem, logged once', async () => {
    let found: { hopperUrl: string } | { addressProblem: string } = { hopperUrl: 'http://10.0.0.2:4790' };
    let t = 0;
    const lines: string[] = [];
    const src = createAttachedMachineSource({
      machine: () => ({ name: 'laptop', ssh: 'laptop', lanes: 1, executors: ['herdr-claude'], herdr: true, session: 'hopper' }),
      clock: { now: () => new Date(t) }, probeEveryMs: 30000,
      probe: async () => ({ online: true, home: '/home/x', ...found }),
      logger: { info: (l) => lines.push(l), warn: (l) => lines.push(l) },
    });
    await src.list();
    await flush();
    expect((await src.list())[0]).toMatchObject({ hopperUrl: 'http://10.0.0.2:4790' });
    expect((await src.list())[0]).not.toHaveProperty('addressProblem');
    found = { addressProblem: 'the hopper cannot be reached from it: http://hopper:4790 (no connection)' };
    t += 30000;
    await src.list();
    await flush();
    const [m] = await src.list();
    expect(m).toMatchObject({ addressProblem: found.addressProblem });
    expect(m).not.toHaveProperty('hopperUrl');
    expect(lines.at(-1)).toBe(`hopper: attached machine laptop online (ssh laptop), takes no new job: ${found.addressProblem}`);
  });
});

describe('probeSsh', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jh-ssh-address-'));
    process.env.FAKE_HERDR_DIR = dir;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // Issue #698: the machine itself says which of the hopper's addresses it reaches; the work tree is still checked.
  it('given the hopper\'s addresses: the one the machine reaches, with its work tree made', async () => {
    const s = createServer((_req, res) => { res.statusCode = 204; res.end(); });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const good = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    try {
      const r = await probeSsh({ target: 'laptop', sshBin: SSH, controlDir: join(dir, 's'), auth: testSshAuth(join(dir, 'auth')), hopperUrls: ['http://127.0.0.1:1', good] });
      expect(r).toMatchObject({ home: process.env.HOME, hopperUrl: good });
      expect(r).not.toHaveProperty('workTreeProblem');
      expect(r).not.toHaveProperty('addressProblem');
    } finally {
      await new Promise((r) => s.close(r));
    }
  });

  it('given addresses it reaches none of: its address problem, and a work tree problem still said', async () => {
    const r = await probeSsh({ target: 'laptop', sshBin: SSH, controlDir: join(dir, 's'), auth: testSshAuth(join(dir, 'auth')), hopperUrls: ['http://127.0.0.1:1'], workTree: '/proc/hopper-no-such/tree' });
    expect(r.addressProblem).toMatch(/^the hopper cannot be reached from it: http:\/\/127\.0\.0\.1:1 \(no connection\)/);
    expect(r).not.toHaveProperty('hopperUrl');
    expect(r.workTreeProblem).toMatch(/^its work tree \/proc\/hopper-no-such\/tree cannot be made: /);
    expect(r.workTreeProblem).not.toContain('hopper-address');
  });
});
