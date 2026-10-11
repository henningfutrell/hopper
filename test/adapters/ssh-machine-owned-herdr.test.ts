// Issue #741: the herdr the hopper owns on an ssh target. The keeper copies the hopper's own herdr to
// ~/.local/share/hopper/herdr/<version>/herdr there, and every herdr call there runs it (the `current` link) once the
// session server takes it. When the server runs another protocol and nothing there can be lost, the keeper restarts
// the server from that path, once per version. Over the fake ssh, which runs each command in a real shell here.
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHerdrCliClient } from '../../src/executors/herdr/index.ts';
import { createOwnedHerdrKeeper, type HopperHerdr } from '../../src/machines/herdr-owned-ssh.ts';
import { testSshAuth } from '../support/ssh.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
const SSH = fileURLToPath(new URL('../herdr/fake-ssh-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);
chmodSync(SSH, 0o755);

const SESSION = 'jh-owned-test';
// The machine is this computer, as the fake ssh runs it here.
const PLATFORM = execFileSync('uname', ['-sm'], { encoding: 'utf8' }).trim();
let dir: string;
let there: string;
const saved = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jh-owned-herdr-'));
  there = join(dir, 'there');
  // The machine: herdr's own install in ~/.local/bin; the hopper's herdr is another copy, here.
  mkdirSync(join(there, '.local', 'bin'), { recursive: true });
  symlinkSync(HERDR, join(there, '.local', 'bin', 'herdr'));
  mkdirSync(join(dir, 'hopper-own'));
  copyFileSync(HERDR, join(dir, 'hopper-own', 'herdr'));
  chmodSync(join(dir, 'hopper-own', 'herdr'), 0o755);
  Object.assign(process.env, { FAKE_HERDR_DIR: dir, HOME: there,
    // node for the fake ssh and herdr (it may live outside /usr/bin); never this computer's own herdr.
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, FAKE_HERDR_RUNNING: '1' });
  delete process.env.XDG_CONFIG_HOME;
});

afterEach(() => {
  process.env = { ...saved };
  rmSync(dir, { recursive: true, force: true });
});

const ours = (version = '0.9.3', platform = PLATFORM): HopperHerdr => ({ path: join(dir, 'hopper-own', 'herdr'), version, platform });
const target = { target: 'seat', session: SESSION, sshBin: SSH, controlDir: join(dir, 's'), auth: testSshAuth(join(dir, 'auth')) };
const keeper = (h: HopperHerdr | { problem: string } = ours()) => {
  const lines: string[] = [];
  const keep = createOwnedHerdrKeeper({ herdr: () => h, logger: { info: (l) => lines.push(l), warn: (l) => lines.push(l) } });
  return { keep, lines };
};
const ownedDir = (v: string) => join(there, '.local', 'share', 'hopper', 'herdr', v);
const current = () => join(there, '.local', 'share', 'hopper', 'herdr', 'current');
const calls = (): string[][] => readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { argv: string[] }).argv);

describe('owned herdr keeper', () => {
  it('copies the hopper\'s herdr to its versioned path there; the server takes it, so every call runs it', async () => {
    Object.assign(process.env, { FAKE_HERDR_OWNED: '0.9.3 22', FAKE_HERDR_SERVER: '0.9.3 22', FAKE_HERDR_CLIENT: '0.9.3 22' });
    const { keep } = keeper();
    expect(await keep(target, () => false)).toEqual({ version: '0.9.3', inUse: true });
    expect(existsSync(join(ownedDir('0.9.3'), 'herdr'))).toBe(true);
    expect(readlinkSync(current())).toBe('0.9.3');
    const client = await createHerdrCliClient({ session: SESSION, ssh: { target: 'seat', bin: SSH, controlDir: join(dir, 's'), auth: target.auth } }).exec(['status', 'client']);
    expect(client).toContain(`binary: ${join(current(), 'herdr')}`);
  });

  it('a machine of another platform: nothing copied, herdr found as before, and why', async () => {
    Object.assign(process.env, { FAKE_HERDR_OWNED: '0.9.3 22', FAKE_HERDR_SERVER: '0.9.3 22' });
    const { keep } = keeper(ours('0.9.3', 'Darwin arm64'));
    const r = await keep(target, () => false);
    expect(r).toMatchObject({ version: '0.9.3', inUse: false });
    expect(r.note).toMatch(/^herdr is not installed at the hopper's path: the machine is \S+ \S+, the hopper's herdr is for Darwin arm64; herdr is found in ~\/\.local\/bin, then its PATH$/);
    expect(existsSync(ownedDir('0.9.3'))).toBe(false);
  });

  it('the hopper has no herdr of its own: nothing copied, and why', async () => {
    const { keep } = keeper({ problem: 'the hopper has no herdr of its own: herdr is not on its PATH' });
    expect(await keep(target, () => false)).toEqual({ inUse: false, note: 'the hopper has no herdr of its own: herdr is not on its PATH' });
  });

  it('the server runs another protocol, a job runs there: no restart, calls keep the herdr the server takes', async () => {
    Object.assign(process.env, { FAKE_HERDR_OWNED: '0.9.3 22', FAKE_HERDR_SERVER: '0.8.2 20', FAKE_HERDR_CLIENT: '0.8.2 20' });
    const { keep } = keeper();
    const r = await keep(target, () => true);
    expect(r).toEqual({ version: '0.9.3', inUse: false, note: 'a job runs there: its session server moves to herdr 0.9.3 once none does' });
    expect(existsSync(current())).toBe(false);
    expect(existsSync(join(ownedDir('0.9.3'), 'switch-tried'))).toBe(false);
  });

  it('panes open in its session: no restart', async () => {
    Object.assign(process.env, { FAKE_HERDR_OWNED: '0.9.3 22', FAKE_HERDR_SERVER: '0.8.2 20', FAKE_HERDR_CLIENT: '0.8.2 20', FAKE_HERDR_PANES: '1' });
    const r = await keeper().keep(target, () => false);
    expect(r.note).toBe('1 pane is open in its herdr session: its session server moves to herdr 0.9.3 once none is');
    expect(calls().some((a) => a.includes('stop'))).toBe(false);
  });

  it('idle, another protocol: the server restarts from the hopper\'s path, once, and calls run it', async () => {
    Object.assign(process.env, { FAKE_HERDR_OWNED: '0.9.3 22', FAKE_HERDR_SERVER: '0.8.2 20', FAKE_HERDR_CLIENT: '0.8.2 20' });
    const { keep, lines } = keeper();
    expect(await keep(target, () => false)).toEqual({ version: '0.9.3', inUse: true });
    expect(readlinkSync(current())).toBe('0.9.3');
    expect(existsSync(join(ownedDir('0.9.3'), 'switch-tried'))).toBe(true);
    expect(readFileSync(join(dir, 'server-now'), 'utf8')).toBe('0.9.3 22');
    expect(lines).toEqual(['hopper: ssh seat: its herdr session server now runs the hopper\'s herdr 0.9.3 (it ran 0.8.2)']);
  });

  it('tried once for this version and still another protocol: never again, and what to do', async () => {
    Object.assign(process.env, { FAKE_HERDR_OWNED: '0.9.3 22', FAKE_HERDR_SERVER: '0.8.2 20', FAKE_HERDR_CLIENT: '0.8.2 20' });
    mkdirSync(ownedDir('0.9.3'), { recursive: true });
    copyFileSync(HERDR, join(ownedDir('0.9.3'), 'herdr'));
    chmodSync(join(ownedDir('0.9.3'), 'herdr'), 0o755);
    writeFileSync(join(ownedDir('0.9.3'), 'switch-tried'), '');
    const r = await keeper().keep(target, () => false);
    expect(r.note).toBe('its session server was moved to herdr 0.9.3 once and does not run it: restart it there with ~/.local/share/hopper/herdr/0.9.3/herdr');
    expect(existsSync(join(dir, 'server-now'))).toBe(false);
  });
});
