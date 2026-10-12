// Issue #741: an ssh target's herdr client and server versions, and its herdr problem, said on the machine and in the
// log. A probe that finds the problem gone clears it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAttachedMachineSource, probeHerdrOverSsh, type MachineProbe } from '../../src/machines/index.ts';
import { testSshAuth } from '../support/ssh.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
const SSH = fileURLToPath(new URL('../herdr/fake-ssh-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);
chmodSync(SSH, 0o755);

const flush = () => new Promise((r) => setImmediate(r));
const PROBLEM = 'its herdr client 0.7.5 (protocol 17, /usr/local/bin/herdr) is not compatible with its herdr server 0.9.3 (protocol 22): install the server\'s herdr there';

describe('attached machine source: herdr', () => {
  it('its snapshot carries the herdr versions and the herdr problem its probe found, logged once', async () => {
    let found: Partial<MachineProbe> = {
      herdr: { client: { version: '0.7.5', protocol: 17, binary: '/usr/local/bin/herdr' }, server: { version: '0.9.3', protocol: 22 } }, herdrProblem: PROBLEM,
    };
    let t = 0;
    const lines: string[] = [];
    const src = createAttachedMachineSource({
      machine: () => ({ name: 'seat', ssh: 'seat', lanes: 1, executors: ['herdr-claude'], herdr: true, session: 'hopper' }),
      clock: { now: () => new Date(t) }, probeEveryMs: 30000,
      probe: async () => ({ online: true, home: '/home/x', ...found }),
      logger: { info: (l) => lines.push(l), warn: (l) => lines.push(l) },
    });
    await src.list();
    await flush();
    expect((await src.list())[0]).toMatchObject({
      online: true, herdrProblem: PROBLEM,
      herdr: { session: 'hopper', client: { version: '0.7.5', protocol: 17, binary: '/usr/local/bin/herdr' }, server: { version: '0.9.3', protocol: 22 } },
    });
    expect(lines).toEqual([`hopper: attached machine seat online (ssh seat), takes no new job: ${PROBLEM}`]);
    found = { herdr: { client: { version: '0.9.3', protocol: 22 }, server: { version: '0.9.3', protocol: 22 } } };
    t += 30000;
    await src.list();
    await flush();
    const [m] = await src.list();
    expect(m).not.toHaveProperty('herdrProblem');
    expect(m!.herdr).toEqual({ session: 'hopper', client: { version: '0.9.3', protocol: 22 }, server: { version: '0.9.3', protocol: 22 } });
    expect(lines.at(-1)).toBe('hopper: attached machine seat online (ssh seat)');
  });
});

describe('probeHerdrOverSsh: the herdr versions', () => {
  let dir: string;
  const saved = { ...process.env };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jh-ssh-herdr-'));
    process.env.FAKE_HERDR_DIR = dir;
    // The fake ssh runs the command here: herdr, by name, from the machine's ~/.local/bin.
    process.env.HOME = join(dir, 'there');
    mkdirSync(join(dir, 'there', '.local', 'bin'), { recursive: true });
    symlinkSync(HERDR, join(dir, 'there', '.local', 'bin', 'herdr'));
    // Never this computer's own herdr, wherever its PATH has it.
    process.env.PATH = '/usr/bin:/bin';
  });
  afterEach(() => {
    process.env = { ...saved };
    rmSync(dir, { recursive: true, force: true });
  });
  const probe = (target: string) => probeHerdrOverSsh({ target, sshBin: SSH, session: 'hopper', controlDir: join(dir, 's'), auth: testSshAuth(join(dir, 'auth')) });

  // Issue #741: the herdr client the hopper calls there and the server of its session.
  it('reads the herdr client and server versions, and the binary the hopper calls: ~/.local/bin\'s', async () => {
    Object.assign(process.env, { FAKE_HERDR_RUNNING: '1', FAKE_HERDR_SERVER: '0.9.3 22 yes', FAKE_HERDR_CLIENT: '0.9.3 22' });
    const p = await probe('laptop');
    expect(p).toEqual({ online: true, herdr: { client: { version: '0.9.3', protocol: 22, binary: join(dir, 'there', '.local', 'bin', 'herdr') }, server: { version: '0.9.3', protocol: 22 } } });
  });

  it('a client the server does not take: a herdr problem, still online', async () => {
    Object.assign(process.env, { FAKE_HERDR_RUNNING: '1', FAKE_HERDR_SERVER: '0.9.3 22 no', FAKE_HERDR_CLIENT: '0.7.5 17' });
    const p = await probe('laptop');
    expect(p.online).toBe(true);
    expect(p.herdrProblem).toMatch(/^its herdr client 0\.7\.5 \(protocol 17, \S+\) is not compatible with its herdr server 0\.9\.3 \(protocol 22\): install the server's herdr there$/);
  });

  it('herdr\'s own protocol error: a herdr problem, still online', async () => {
    process.env.FAKE_HERDR_PROTOCOL_ERROR = '1';
    expect(await probe('laptop')).toEqual({ online: true, herdrProblem: 'its herdr client (protocol 17) is not compatible with its herdr server (protocol 22): install the server\'s herdr there' });
  });

});
