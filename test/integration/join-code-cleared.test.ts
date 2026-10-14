// Issue #606 through the real composition root: a machine that joins with a join line (a sandbox box) keeps
// no copy of the spent join code. A box's entrypoint (scripts/box/entrypoint.sh) moves HOPPER_JOIN into a
// file only its user can read and names it in HOPPER_JOIN_FILE; the client reads the file, removes it, and
// takes HOPPER_JOIN_FILE out of its environment before it starts anything. So neither the client process nor
// a process it starts (herdr, the jobs' panes) can read the code, and a restart dials in from the link alone.
//
// Feature: the join code leaves the box
//   Scenario: a machine joins with a join file, and nothing it runs has the code
//     Given a hopper and a join code an admin minted
//     When the client starts with HOPPER_JOIN_FILE naming a file that holds the hopper's URL and that code
//     Then the machine is online
//     And the file is gone
//     And the code is not in the client process's environment
//     And no herdr call the client made got HOPPER_JOIN or HOPPER_JOIN_FILE
//   Scenario: a restart needs no join code
//     Given that machine, joined, its client stopped
//     When the client starts again, given the spent join line again
//     Then the machine is online again, the same machine, and the file is gone
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { testInstallDir } from '../support/client.ts';
import { waitFor } from '../support/wait.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);

let t: TestApp | undefined;
const cleanups: (() => void)[] = [];

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) c();
  await t?.stop();
  t = undefined;
});

const machinesOf = async (a: TestApp) => (await a.api('GET', '/api/machines')).body.machines as { id: string; online: boolean }[];
const isOnline = async (a: TestApp, name: string) => (await machinesOf(a)).find((m) => m.id === name)?.online === true;

describe('a machine that joined with a join line keeps no copy of the join code', () => {
  it('the join file is removed; neither the client nor a process it starts has the code; a restart dials in with no join code', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const herdrDir = dirname(db.dbPath);
    t = await startTestApp({ dbPath: db.dbPath, plugins: { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 1, executors: ['test'] } } });
    const a = t;
    const code = (await a.ui<{ code: string }>('/ui/api/machines/join', {}, { token: await a.login() })).body.code;
    const root = mkdtempSync(join(tmpdir(), 'jh-join-cleared-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    symlinkSync(HERDR, join(bin, 'herdr'));
    const install = testInstallDir();
    cleanups.push(() => rmSync(dirname(install), { recursive: true, force: true }));
    const joinFile = join(root, 'hopper-join');
    const env = {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, HOPPER_CLIENT_DIR: join(root, 'client-dir'), HOPPER_CLIENT_SESSION: 'hopper',
      HOPPER_CLIENT_NAME: 'box', HOPPER_JOIN_FILE: joinFile, FAKE_HERDR_DIR: herdrDir, FAKE_HERDR_RUNNING: '1',
    };
    const start = (): ChildProcess => {
      writeFileSync(joinFile, `${a.url}#${code}\n`, { mode: 0o600 });
      const child = spawn(process.execPath, [join(install, 'main.ts')], { cwd: root, env, stdio: 'ignore' });
      cleanups.push(() => child.kill('SIGKILL'));
      return child;
    };
    const stop = async (child: ChildProcess): Promise<void> => {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      await exited;
    };

    const first = start();
    await waitFor(async () => (await isOnline(a, 'box')) || undefined, { timeoutMs: 15000, what: 'box online' });
    expect(existsSync(joinFile)).toBe(false);
    const environ = readFileSync(`/proc/${first.pid}/environ`, 'utf8');
    expect(environ).not.toContain(code);
    expect(environ.split('\0')).toContain('HOPPER_CLIENT_NAME=box');
    const calls = join(herdrDir, 'calls.jsonl');
    const herdrCalls = (): { hopperJoin?: boolean }[] => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { hopperJoin?: boolean }) : []);
    expect(herdrCalls().length).toBeGreaterThan(0);
    expect(herdrCalls().filter((c) => c.hopperJoin)).toEqual([]);

    await stop(first);
    const before = herdrCalls().length;
    // The code is spent: had the client tried it again, the join would fail and the client exit 1.
    const second = start();
    let exitCode: number | null | undefined;
    second.once('exit', (c) => { exitCode = c; });
    // Online through the new client: the hopper's probe reaches its herdr over the new link.
    await waitFor(async () => (await isOnline(a, 'box')) && herdrCalls().length > before || undefined, { timeoutMs: 15000, what: 'box online again' });
    expect(exitCode).toBeUndefined();
    expect(existsSync(joinFile)).toBe(false);
    expect(readFileSync(`/proc/${second.pid}/environ`, 'utf8')).not.toContain(code);
    expect(herdrCalls().filter((c) => c.hopperJoin)).toEqual([]);
    expect((await machinesOf(a)).map((m) => m.id)).toEqual(['box']);
  }, 60000);
});
