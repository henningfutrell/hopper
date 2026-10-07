// The herdr CLI client on an attached machine: every call goes through `ssh`, and the remote
// shell must hand herdr exactly the argv the local client would (design.md "Attached machines").
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HerdrError, createHerdrCliClient } from '../../src/executors/herdr/index.ts';
import { userSshConfig } from '../../src/executors/ssh.ts';
import { testSshAuth } from '../support/ssh.ts';

const HERDR = fileURLToPath(new URL('./fake-herdr-bin.mjs', import.meta.url));
const SSH = fileURLToPath(new URL('./fake-ssh-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);
chmodSync(SSH, 0o755);

let dir: string;
const saved = { ...process.env };
const lines = (f: string): { argv: string[] }[] =>
  readFileSync(join(dir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { argv: string[] });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jh-herdr-ssh-'));
  process.env.FAKE_HERDR_DIR = dir;
  // The fake ssh runs the command here: the machine's home is this test's, herdr in its ~/.local/bin.
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

const remote = (target = 'laptop') => createHerdrCliClient({
  session: 'jh-test-x', ssh: { target, bin: SSH, controlDir: join(dir, 'ssh'), auth: testSshAuth(join(dir, 'auth')) },
});

describe('herdr CLI client over ssh', () => {
  it('passes herdr argv through the remote shell unchanged, whatever the text holds', async () => {
    const text = `it's "quoted" $HOME \`date\` \\ ; | & * ~\nsecond line\n`;
    await remote().prompt('jh-a', text);
    expect(lines('calls.jsonl')[0]!.argv).toEqual(['--session', 'jh-test-x', 'agent', 'prompt', 'jh-a', text]);
  });

  it('calls herdr by name, from the machine\'s PATH and then ~/.local/bin: no binary path to name (issue #311)', async () => {
    await remote().getAgent('jh-a');
    const argv = lines('ssh-calls.jsonl')[0]!.argv;
    expect(argv.at(-1)).toBe(`PATH="$PATH:$HOME/.local/bin" exec 'herdr' '--session' 'jh-test-x' 'agent' 'get' 'jh-a'`);
  });

  it('herdr on the machine\'s PATH wins over ~/.local/bin', async () => {
    const bin = join(dir, 'path-bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'herdr'), `#!/bin/sh\necho "{\\"result\\":{\\"from\\":\\"path\\"}}"\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    expect(await remote().run(['status'])).toEqual({ from: 'path' });
  });

  it('calls ssh in batch mode over one shared connection, the resolved host after --', async () => {
    await remote().getAgent('jh-a');
    const argv = lines('ssh-calls.jsonl')[0]!.argv;
    const sep = argv.indexOf('--');
    expect(argv[sep + 1]).toBe('laptop.example');
    const opts = argv.slice(0, sep);
    expect(opts).toEqual(expect.arrayContaining([
      '-o', 'BatchMode=yes', '-o', 'ControlMaster=auto',
    ]));
    expect(opts.find((o) => o.startsWith('ControlPath='))).toMatch(new RegExp(`^ControlPath=${join(dir, 'ssh')}/[0-9a-f]{16}$`));
    expect(opts.some((o) => o.startsWith('ControlPersist='))).toBe(true);
    expect(opts.some((o) => o.startsWith('ConnectTimeout='))).toBe(true);
  });

  it('resolves the target with the user\'s ssh config only, never /etc/ssh (under the unit those files look foreign-owned), and connects with none', async () => {
    await remote().getAgent('jh-a');
    const argv = lines('ssh-calls.jsonl')[0]!.argv;
    expect(argv.slice(0, 2)).toEqual(['-F', '/dev/null']);
    const home = join(dir, 'home');
    expect(userSshConfig(home)).toBe('/dev/null');
    mkdirSync(join(home, '.ssh'), { recursive: true });
    writeFileSync(join(home, '.ssh', 'config'), 'Host laptop\n');
    expect(userSshConfig(home)).toBe(join(home, '.ssh', 'config'));
  });

  it('remote herdr results and errors come back as they do locally', async () => {
    expect(await remote().getAgent('jh-a')).toEqual({ status: 'idle', stateChangeSeq: 4, paneId: 'w7:p5' });
    expect(await remote().getAgent('jh-gone')).toBeNull();
    await expect(remote().run(['usage'])).rejects.toMatchObject({ code: 'usage' });
  });

  it('an ssh failure (exit 255) is code ssh, naming the target', async () => {
    const err = await remote('unreachable').getAgent('jh-a').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HerdrError);
    expect(err).toMatchObject({ code: 'ssh' });
    expect((err as Error).message).toMatch(/unreachable/);
  });

  it('refuses a target that ssh would read as an option, before running ssh', async () => {
    const client = createHerdrCliClient({ session: 's', ssh: { target: '-oProxyCommand=x', bin: SSH, auth: testSshAuth(join(dir, 'auth')) } });
    await expect(client.getAgent('jh-a')).rejects.toMatchObject({ code: 'ssh', message: expect.stringMatching(/bad ssh target/) });
  });

  it('without the hopper\'s ssh key: code ssh, and ssh is never run', async () => {
    const client = createHerdrCliClient({ session: 's', ssh: { target: 'laptop', bin: SSH, auth: () => { throw new Error('no ssh key for the hopper'); } } });
    await expect(client.getAgent('jh-a')).rejects.toMatchObject({ code: 'ssh', message: expect.stringMatching(/no ssh key for the hopper/) });
    expect(() => lines('ssh-calls.jsonl')).toThrow();
  });
});
