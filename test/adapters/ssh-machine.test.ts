// An attached machine (design.md "Attached machines"): online while its herdr session answers over
// ssh. The probe runs in the background on its own cadence; list() never waits for it, so a
// machine that is off or asleep never stalls a Decision.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAttachedMachineSource, probeHerdrOverSsh, resolveHerdrBinOverSsh } from '../../src/machines/index.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
const SSH = fileURLToPath(new URL('../herdr/fake-ssh-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);
chmodSync(SSH, 0o755);

const flush = () => new Promise((r) => setImmediate(r));

function harness(results: (boolean | Error)[]) {
  let t = 0;
  const lines: string[] = [];
  let calls = 0;
  const src = createAttachedMachineSource({
    machine: () => ({ name: 'laptop', ssh: 'laptop', lanes: 2, executors: ['herdr-claude'], session: 'job-hopper', herdrBin: '/home/user/.local/bin/herdr' }),
    clock: { now: () => new Date(t) },
    probeEveryMs: 30000,
    probe: async () => {
      const r = results[Math.min(calls++, results.length - 1)]!;
      if (r instanceof Error) throw r;
      return r;
    },
    logger: { info: (l) => lines.push(l), warn: (l) => lines.push(l) },
  });
  return { src, lines, probes: () => calls, advance: (ms: number) => { t += ms; } };
}

describe('attached machine source', () => {
  it('is offline until the first probe answers, then online with its lanes, executors and ssh target', async () => {
    const h = harness([true]);
    expect(await h.src.list()).toEqual([{
      id: 'laptop', label: 'laptop', maxLanes: 2, online: false, executors: ['herdr-claude'], ssh: 'laptop',
      herdr: { bin: '/home/user/.local/bin/herdr', session: 'job-hopper' },
    }]);
    await flush();
    expect((await h.src.list())[0]).toMatchObject({ online: true });
    expect(h.lines).toEqual(['job-hopper: attached machine laptop online (ssh laptop)']);
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
      'job-hopper: attached machine laptop online (ssh laptop)',
      'job-hopper: attached machine laptop offline: ssh laptop: No route to host',
      'job-hopper: attached machine laptop offline: its herdr session is not running',
    ]);
  });

  it('honours a label', async () => {
    const h = createAttachedMachineSource({
      machine: () => ({ name: 'laptop', label: 'arch-laptop', ssh: 'laptop', lanes: 1, executors: [], session: 'job-hopper', herdrBin: 'herdr' }), probe: async () => true,
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
  });
  afterEach(() => {
    process.env = { ...saved };
    rmSync(dir, { recursive: true, force: true });
  });
  const probe = (target: string) => probeHerdrOverSsh({ target, sshBin: SSH, herdrBin: HERDR, session: 'job-hopper', controlDir: join(dir, 's') });

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

// Adding a machine from the UI (issue #18): herdrBin is never typed; the daemon asks the machine.
describe('resolveHerdrBinOverSsh', () => {
  let home: string;
  const saved = { ...process.env };
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'jh-ssh-home-'));
    process.env.FAKE_HERDR_DIR = home;
    process.env.HOME = home;
    process.env.SHELL = '/bin/sh';
  });
  afterEach(() => {
    process.env = { ...saved };
    rmSync(home, { recursive: true, force: true });
  });
  const executable = (path: string) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '#!/bin/sh\necho herdr\n', { mode: 0o755 });
  };
  const resolve = (target: string) => resolveHerdrBinOverSsh({ target, sshBin: SSH, controlDir: join(home, 's') });

  it('the absolute path a login shell there finds', async () => {
    executable(join(home, 'tools', 'herdr'));
    writeFileSync(join(home, '.profile'), `PATH="${join(home, 'tools')}:$PATH"; export PATH\necho motd line\n`);
    expect(await resolve('laptop')).toBe(join(home, 'tools', 'herdr'));
  });

  it('else ~/.local/bin/herdr when it is executable', async () => {
    executable(join(home, '.local', 'bin', 'herdr'));
    expect(await resolve('laptop')).toBe(join(home, '.local', 'bin', 'herdr'));
  });

  it('rejects with the reason when herdr is nowhere, or the machine cannot be reached', async () => {
    await expect(resolve('laptop')).rejects.toThrow(/herdr not found/);
    await expect(resolve('unreachable')).rejects.toThrow(/ssh unreachable/);
  });
});
