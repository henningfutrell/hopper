// An attached machine (design.md "Attached machines"): online while its herdr session answers over
// ssh. The probe runs in the background on its own cadence; list() never waits for it, so a
// machine that is off or asleep never stalls a Decision.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAttachedMachineSource, probeHerdrOverSsh, probeSsh, resolveSshTarget } from '../../src/machines/index.ts';
import { DF_COMMAND, diskOf } from '../../src/machines/disk.ts';
import { RESOURCES_COMMAND } from '../../src/machines/resources.ts';
import { TEST_HOST_KEY, testSshAuth } from '../support/ssh.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
const SSH = fileURLToPath(new URL('../herdr/fake-ssh-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);
chmodSync(SSH, 0o755);

const flush = () => new Promise((r) => setImmediate(r));

function harness(results: (boolean | Error)[], herdr = true) {
  let t = 0;
  const lines: string[] = [];
  let calls = 0;
  const src = createAttachedMachineSource({
    machine: () => ({ name: 'laptop', ssh: 'laptop', lanes: 2, executors: ['herdr-claude'], herdr, session: 'hopper' }),
    clock: { now: () => new Date(t) },
    probeEveryMs: 30000,
    probe: async () => {
      const r = results[Math.min(calls++, results.length - 1)]!;
      if (r instanceof Error) throw r;
      return { online: r };
    },
    logger: { info: (l) => lines.push(l), warn: (l) => lines.push(l) },
  });
  return { src, lines, probes: () => calls, advance: (ms: number) => { t += ms; } };
}

describe('attached machine source', () => {
  it('its snapshot carries the machine\'s work tree (issue #324)', async () => {
    const src = createAttachedMachineSource({
      machine: () => ({ name: 'laptop', ssh: 'laptop', lanes: 1, executors: ['herdr-claude'], herdr: true, session: 'hopper', workTree: '~/trees' }),
      probe: async () => ({ online: true }),
    });
    expect((await src.list())[0]).toMatchObject({ workTree: '~/trees' });
  });

  it('judges its disk low by the machine\'s own thresholds, as they are at each list (issue #410)', async () => {
    const GIB = 1024 ** 3;
    let belowGiB = 0;
    const src = createAttachedMachineSource({
      machine: () => ({ name: 'laptop', ssh: 'laptop', lanes: 1, executors: ['herdr-claude'], herdr: true, session: 'hopper', ...(belowGiB ? { diskLow: { belowGiB } } : {}) }),
      probe: async () => ({ online: true, disk: diskOf(30 * GIB, 100 * GIB) }),
    });
    await src.list();
    await flush();
    expect((await src.list())[0]!.disk?.low).toBe(false);
    belowGiB = 40;
    expect((await src.list())[0]!.disk).toEqual({ freeBytes: 30 * GIB, totalBytes: 100 * GIB, low: true });
  });

  it('its snapshot carries the machine\'s reserved lanes (issue #372)', async () => {
    const src = createAttachedMachineSource({
      machine: () => ({ name: 'laptop', ssh: 'laptop', lanes: 4, reservedLanes: 1, executors: ['herdr-claude'], herdr: true, session: 'hopper' }),
      probe: async () => ({ online: true }),
    });
    expect((await src.list())[0]).toMatchObject({ maxLanes: 4, reservedLanes: 1 });
  });

  it('is offline until the first probe answers, then online with its lanes, executors and ssh target', async () => {
    const h = harness([true]);
    expect(await h.src.list()).toEqual([{
      id: 'laptop', label: 'laptop', maxLanes: 2, online: false, executors: ['herdr-claude'], ssh: 'laptop',
      herdr: { session: 'hopper' },
    }]);
    await flush();
    expect((await h.src.list())[0]).toMatchObject({ online: true });
    expect(h.lines).toEqual(['hopper: attached machine laptop online (ssh laptop)']);
  });

  it('one that runs no herdr has no herdr in its snapshot, so no herdr executor reaches it (issue #142)', async () => {
    const [m] = await harness([true], false).src.list();
    expect(m).toEqual({ id: 'laptop', label: 'laptop', maxLanes: 2, online: false, executors: ['herdr-claude'], ssh: 'laptop' });
  });

  it('probes at most once per interval, and again after it', async () => {
    const h = harness([true]);
    await h.src.list();
    await flush();
    for (let i = 0; i < 5; i++) await h.src.list();
    expect(h.probes()).toBe(1);
    h.advance(30000);
    await h.src.list();
    expect(h.probes()).toBe(2);
  });

  it('goes offline when a probe says no or fails, with each new reason logged once', async () => {
    const h = harness([true, new Error('ssh laptop: No route to host'), false, false]);
    await h.src.list(); await flush();
    h.advance(30000); await h.src.list(); await flush();
    expect((await h.src.list())[0]!.online).toBe(false);
    h.advance(30000); await h.src.list(); await flush();
    h.advance(30000); await h.src.list(); await flush(); // same reason again: not logged again
    expect(h.lines).toEqual([
      'hopper: attached machine laptop online (ssh laptop)',
      'hopper: attached machine laptop offline: ssh laptop: No route to host',
      'hopper: attached machine laptop offline: its herdr session is not running',
    ]);
  });

  it('carries the home its probe found, so ~ in a work tree resolves there (issue #323); a probe without one keeps it', async () => {
    let answer: { online: boolean; home?: string } = { online: true, home: '/home/far' };
    let t = 0;
    const src = createAttachedMachineSource({
      machine: () => ({ name: 'laptop', ssh: 'laptop', lanes: 1, executors: [], herdr: true, session: 'hopper' }),
      clock: { now: () => new Date(t) }, probeEveryMs: 30000, probe: async () => answer,
    });
    expect((await src.list())[0]).not.toHaveProperty('home');
    await flush();
    expect((await src.list())[0]).toMatchObject({ online: true, home: '/home/far' });
    answer = { online: false };
    t += 30000; await src.list(); await flush();
    expect((await src.list())[0]).toMatchObject({ online: false, home: '/home/far' });
  });

  it('carries the disk its last probe read (issue #401); a probe that read none drops it', async () => {
    let answer: { online: boolean; disk?: ReturnType<typeof diskOf> } = { online: true, disk: diskOf(1, 2) };
    let t = 0;
    const src = createAttachedMachineSource({
      machine: () => ({ name: 'laptop', ssh: 'laptop', lanes: 1, executors: [], herdr: true, session: 'hopper' }),
      clock: { now: () => new Date(t) }, probeEveryMs: 30000, probe: async () => answer,
    });
    await src.list(); await flush();
    expect((await src.list())[0]!.disk).toEqual(diskOf(1, 2));
    answer = { online: false };
    t += 30000; await src.list(); await flush();
    expect((await src.list())[0]).not.toHaveProperty('disk');
  });

  it('carries what its probe found wrong with its work tree, and drops it once a probe finds it usable (issue #361)', async () => {
    let answer: { online: boolean; home?: string; workTreeProblem?: string } = { online: true, home: '/home/far', workTreeProblem: 'its work tree /srv/x cannot be made: Permission denied' };
    let t = 0;
    const src = createAttachedMachineSource({
      machine: () => ({ name: 'laptop', ssh: 'laptop', lanes: 1, executors: [], herdr: true, session: 'hopper', workTree: '/srv/x' }),
      clock: { now: () => new Date(t) }, probeEveryMs: 30000, probe: async () => answer,
    });
    await src.list(); await flush();
    expect((await src.list())[0]).toMatchObject({ workTree: '/srv/x', workTreeProblem: 'its work tree /srv/x cannot be made: Permission denied' });
    answer = { online: true, home: '/home/far' };
    t += 30000; await src.list(); await flush();
    expect((await src.list())[0]).not.toHaveProperty('workTreeProblem');
  });

  it('honours a label', async () => {
    const h = createAttachedMachineSource({
      machine: () => ({ name: 'laptop', label: 'arch-laptop', ssh: 'laptop', lanes: 1, executors: [], herdr: true, session: 'hopper' }), probe: async () => ({ online: true }),
    });
    expect((await h.list())[0]!.label).toBe('arch-laptop');
  });
});

describe('probeHerdrOverSsh', () => {
  let dir: string;
  const saved = { ...process.env };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jh-ssh-probe-'));
    process.env.FAKE_HERDR_DIR = dir;
    // The fake ssh runs the command here: herdr, by name, from the machine's ~/.local/bin (issue #311).
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

  it('true when the remote herdr session reports running', async () => {
    process.env.FAKE_HERDR_RUNNING = '1';
    expect(await probe('laptop')).toBe(true);
  });

  it('false when the session is not running', async () => {
    expect(await probe('laptop')).toBe(false);
  });

  it('rejects with the ssh failure when the machine cannot be reached', async () => {
    await expect(probe('unreachable')).rejects.toThrow(/ssh unreachable/);
  });
});

// Issue #142: an ssh target that runs no herdr (its executors are Cursor or commands) is online while
// it answers over ssh.
describe('probeSsh', () => {
  let dir: string;
  const home = process.env.HOME;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jh-ssh-plain-'));
    process.env.FAKE_HERDR_DIR = dir;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const probe = (target: string) => probeSsh({ target, sshBin: SSH, controlDir: join(dir, 's'), auth: testSshAuth(join(dir, 'auth')) });

  it('answers with the machine\'s home when it answers over ssh, with the hopper\'s key; nothing of herdr asked (issue #323)', async () => {
    // The fake ssh runs the command in a local shell: the home is this test's own HOME.
    expect(await probe('laptop')).toMatchObject({ home: process.env.HOME });
    const argv = (JSON.parse(readFileSync(join(dir, 'ssh-calls.jsonl'), 'utf8').trim()) as { argv: string[] }).argv;
    expect(argv.at(-1)).toMatch(/^printf '%s\\n' "\$HOME"; /);
    expect(argv.at(-1)).toContain(DF_COMMAND);
    expect(argv.at(-1)).not.toContain('herdr');
  });

  it('answers the disk its home is on too, so the UI warns before it fills (issue #401)', async () => {
    const { disk } = await probe('laptop');
    expect(disk?.totalBytes).toBeGreaterThan(0);
    expect(disk?.freeBytes).toBeLessThanOrEqual(disk!.totalBytes);
  });

  it('answers the machine\'s CPU, memory and swap too, from two reads of /proc a second apart (issue #560)', async () => {
    const { resources } = await probe('laptop');
    expect(resources?.cores).toBeGreaterThan(0);
    expect(resources?.cpuBusyFrac).toBeGreaterThanOrEqual(0);
    expect(resources?.cpuBusyFrac).toBeLessThanOrEqual(1);
    expect(resources?.memTotalBytes).toBeGreaterThan(0);
    expect(resources?.memAvailableBytes).toBeLessThanOrEqual(resources!.memTotalBytes);
    const argv = (JSON.parse(readFileSync(join(dir, 'ssh-calls.jsonl'), 'utf8').trim()) as { argv: string[] }).argv;
    expect(argv.at(-1)).toContain(RESOURCES_COMMAND);
  });

  // Issue #361: the probe also makes the machine's work tree there (the jobs directory when it names none),
  // so a machine whose work tree cannot be made is known before any job is routed to it.
  it('makes the machine\'s work tree there, under its home, and finds nothing wrong', async () => {
    const r = await probeSsh({ target: 'laptop', sshBin: SSH, controlDir: join(dir, 's'), auth: testSshAuth(join(dir, 'auth')), workTree: '~/trees/a' });
    expect(r).toMatchObject({ home: process.env.HOME });
    expect(r).not.toHaveProperty('workTreeProblem');
    expect(existsSync(join(process.env.HOME!, 'trees', 'a'))).toBe(true);
  });

  it('a machine naming no work tree: the jobs directory is made', async () => {
    const r = await probeSsh({ target: 'laptop', sshBin: SSH, controlDir: join(dir, 's'), auth: testSshAuth(join(dir, 'auth')) });
    expect(r).toMatchObject({ home: process.env.HOME });
    expect(r).not.toHaveProperty('workTreeProblem');
    expect(existsSync(join(process.env.HOME!, 'hopper-jobs'))).toBe(true);
  });

  it('a work tree that cannot be made there: online, with what was wrong', async () => {
    const r = await probeSsh({ target: 'laptop', sshBin: SSH, controlDir: join(dir, 's'), auth: testSshAuth(join(dir, 'auth')), workTree: '/proc/hopper-no-such/tree' });
    expect(r.home).toBe(process.env.HOME);
    expect(r.workTreeProblem).toMatch(/^its work tree \/proc\/hopper-no-such\/tree cannot be made: /);
  });

  it('a work tree that is the home is a problem, and nothing is made', async () => {
    const r = await probeSsh({ target: 'laptop', sshBin: SSH, controlDir: join(dir, 's'), auth: testSshAuth(join(dir, 'auth')), workTree: '~' });
    expect(r.workTreeProblem).toBe('its work tree ~ is its home or above it: a job runs only in a directory below the home');
  });

  it('rejects when the machine answers with no absolute home', async () => {
    process.env.HOME = 'nowhere';
    try {
      await expect(probe('laptop')).rejects.toThrow('laptop: its home is not an absolute path: "nowhere"');
    } finally {
      process.env.HOME = home;
    }
  });

  it('rejects with the ssh failure when the machine cannot be reached', async () => {
    await expect(probe('unreachable')).rejects.toThrow(/ssh unreachable/);
  });
});

// Adding a machine from the UI (issues #18, #59): the daemon checks herdr is found there by name, as
// every call finds it (issue #311), and stores no path; its host key is pinned from the user's own known_hosts, never learned from the connection.
describe('resolveSshTarget', () => {
  let home: string;
  const saved = { ...process.env };
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'jh-ssh-home-'));
    process.env.FAKE_HERDR_DIR = home;
    process.env.HOME = home;
    process.env.SHELL = '/bin/sh';
    // Never this computer's own herdr, wherever its PATH has it.
    process.env.PATH = '/usr/bin:/bin';
    mkdirSync(join(home, '.ssh'), { mode: 0o700 });
    // The stand-in resolves <target> to <target>.example port 2222.
    writeFileSync(join(home, '.ssh', 'known_hosts'), [
      `[laptop.example]:2222 ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQDRh9ldXnc48FmFomQaAcoOZMhpBgnn1srZqnHSTXTkeTu6VJN0OpBHrdOPHOuhIXh9A6hF00dvjqeqjz0otBUh/GRe7jR/811y/10PATyEbCMgoVjxgENlwwGH0Oz/fxq4xMkmJCJnChh/tuf8J8cPapcfKF5NZw7Y4bcgJ8CWJw==`,
      `[laptop.example]:2222 ${TEST_HOST_KEY}`,
      `[unreachable.example]:2222 ${TEST_HOST_KEY}`,
      '',
    ].join('\n'));
  });
  afterEach(() => {
    process.env = { ...saved };
    rmSync(home, { recursive: true, force: true });
  });
  const executable = (path: string) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '#!/bin/sh\necho herdr\n', { mode: 0o755 });
  };
  const resolve = (target: string, herdr = true) => resolveSshTarget({
    target, herdr, sshBin: SSH, controlDir: join(home, 's'), auth: testSshAuth(join(home, 'auth')), knownHosts: join(home, '.ssh', 'known_hosts'),
  });
  const sshCalls = (): string[][] => readFileSync(join(home, 'ssh-calls.jsonl'), 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { argv: string[] }).argv);

  it('herdr on its PATH: the ed25519 key the user\'s known_hosts holds for it, and no herdr path (issue #311)', async () => {
    executable(join(home, 'tools', 'herdr'));
    process.env.PATH = `${join(home, 'tools')}:/usr/bin:/bin`;
    expect(await resolve('laptop')).toEqual({ hostKey: TEST_HOST_KEY });
  });

  it('asks over a connection that trusts only that key, and leaves no trust behind', async () => {
    executable(join(home, '.local', 'bin', 'herdr'));
    await resolve('laptop');
    const argv = sshCalls()[0]!;
    const known = argv.find((a) => a.startsWith('UserKnownHostsFile='))!.slice('UserKnownHostsFile='.length);
    expect(known).toMatch(/known_hosts\.add-[0-9a-f]{12}$/);
    expect(argv).toContain('StrictHostKeyChecking=yes');
    expect(existsSync(known)).toBe(false);
  });

  it('else ~/.local/bin/herdr when it is executable, as every herdr call there finds it', async () => {
    executable(join(home, '.local', 'bin', 'herdr'));
    expect(await resolve('laptop')).toEqual({ hostKey: TEST_HOST_KEY });
    expect(sshCalls()[0]!.at(-1)).toMatch(/^PATH="\$PATH:\$HOME\/\.local\/bin"; command -v herdr /);
  });

  it('a target the user has never connected to: rejected before any connection', async () => {
    await expect(resolve('desk')).rejects.toThrow(/no host key for desk \(\[desk\.example\]:2222\) in ~\/\.ssh\/known_hosts/);
    expect(existsSync(join(home, 'ssh-calls.jsonl'))).toBe(false);
  });

  it('rejects with the reason when herdr is nowhere, or the machine cannot be reached', async () => {
    await expect(resolve('laptop')).rejects.toThrow(/herdr not found/);
    await expect(resolve('unreachable')).rejects.toThrow(/ssh unreachable/);
  });

  it('a machine that runs no herdr (issue #142): only its pinned host key, once it answers over ssh', async () => {
    expect(await resolve('laptop', false)).toEqual({ hostKey: TEST_HOST_KEY });
    expect(sshCalls()).toHaveLength(1);
    await expect(resolve('unreachable', false)).rejects.toThrow(/ssh unreachable/);
  });
});
