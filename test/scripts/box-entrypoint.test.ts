// A sandbox box's entrypoint (scripts/box/entrypoint.sh, issues #308, #606): the join line in HOPPER_JOIN
// leaves the environment before anything starts. The entrypoint writes it to a file only its user can read,
// runs itself again without HOPPER_JOIN — the box's main process keeps no copy in /proc/<pid>/environ — and
// gives the client the file's path in HOPPER_JOIN_FILE (the client reads and removes it, src/client/main.ts).
// herdr, whose panes the jobs run in, never gets either. Told to stop, it stops the client first and waits for it —
// a lane pod's client leaves the hopper and lets its jobs end (issue #1284) — and only then stops herdr, whose panes
// the jobs run in. Run against stand-ins for herdr and node on PATH.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'box', 'entrypoint.sh');
const LINE = 'http://hopper:4790#0123456789abcdef';

let dir: string;
let bin: string;
let home: string;
let tmp: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jh-box-entry-'));
  bin = join(dir, 'bin');
  home = join(dir, 'home');
  tmp = join(dir, 'tmp');
  for (const d of [bin, tmp, join(home, '.local', 'lib', 'hopper-client')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, '.local', 'lib', 'hopper-client', 'main.ts'), '');
  // herdr's server: what it was started with. The jobs' panes are its children.
  writeFileSync(join(bin, 'herdr'), `#!/bin/sh\nenv > "${dir}/herdr.env"\nexec sleep 30\n`);
  // The client: what it was started with, the join file as it found it, and the entrypoint's own environment.
  writeFileSync(join(bin, 'node'), [
    '#!/bin/sh',
    `while [ ! -f "${dir}/herdr.env" ]; do sleep 0.05; done`,
    `env > "${dir}/node.env"`,
    `[ -n "\${HOPPER_JOIN_FILE:-}" ] && [ -f "$HOPPER_JOIN_FILE" ] && { cat "$HOPPER_JOIN_FILE" > "${dir}/join"; stat -c %a "$HOPPER_JOIN_FILE" > "${dir}/join.mode"; rm -f "$HOPPER_JOIN_FILE"; }`,
    `tr '\\0' '\\n' < /proc/$PPID/environ > "${dir}/entrypoint.env"`,
    'exit 0',
  ].join('\n'));
  chmodSync(join(bin, 'herdr'), 0o755);
  chmodSync(join(bin, 'node'), 0o755);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (env: Record<string, string>) => spawnSync('sh', [SCRIPT], {
  encoding: 'utf8', timeout: 10000, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: tmp, ...env },
});
const read = (name: string): string => readFileSync(join(dir, name), 'utf8');

describe('a box\'s entrypoint and its join line', () => {
  it('hands the join line to the client in a file only its user can read; no process keeps HOPPER_JOIN', () => {
    const r = run({ HOPPER_JOIN: LINE });
    expect(r.status).toBe(0);
    expect(read('join').trim()).toBe(LINE);
    expect(read('join.mode').trim()).toBe('600');
    expect(read('node.env')).toMatch(/^HOPPER_JOIN_FILE=/m);
    for (const env of ['node.env', 'herdr.env', 'entrypoint.env']) {
      expect(read(env), env).not.toMatch(/^HOPPER_JOIN=/m);
      expect(read(env), env).not.toContain(LINE);
    }
    expect(read('herdr.env')).not.toMatch(/^HOPPER_JOIN_FILE=/m);
    expect(existsSync(join(tmp, 'hopper-join'))).toBe(false);
  });

  it('without HOPPER_JOIN (a joined box restarted without it): the client gets no join file', () => {
    const r = run({});
    expect(r.status).toBe(0);
    expect(read('node.env')).not.toMatch(/^HOPPER_JOIN/m);
    expect(existsSync(join(dir, 'join'))).toBe(false);
  });
});

describe('a box\'s entrypoint told to stop (issue #1284)', () => {
  it('stops the client and waits for it to end before it stops herdr', async () => {
    // The client takes a while to end when told to stop (a lane pod waits for its jobs); herdr records whether it had.
    writeFileSync(join(bin, 'herdr'), `#!/bin/sh\ntrap 'if [ -f "${dir}/client.done" ]; then echo after > "${dir}/herdr.stop"; else echo before > "${dir}/herdr.stop"; fi; exit 0' TERM\ntouch "${dir}/herdr.up"\nwhile :; do sleep 0.05; done\n`);
    writeFileSync(join(bin, 'node'), `#!/bin/sh\ntrap 'sleep 0.5; touch "${dir}/client.done"; exit 0' TERM\ntouch "${dir}/client.up"\nwhile :; do sleep 0.05; done\n`);
    const child = spawn('sh', [SCRIPT], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: tmp } });
    const ended = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    for (let i = 0; i < 100 && !(existsSync(join(dir, 'client.up')) && existsSync(join(dir, 'herdr.up'))); i++) await new Promise((r) => setTimeout(r, 50));
    child.kill('SIGTERM');
    expect(await ended).toBe(0);
    for (let i = 0; i < 40 && !existsSync(join(dir, 'herdr.stop')); i++) await new Promise((r) => setTimeout(r, 50));
    expect(read('herdr.stop').trim()).toBe('after');
  });

  it('told to stop the moment herdr starts, ends with 0, and stops a client it started before herdr', async () => {
    // Issue #1884: a stop that came before the entrypoint knew its children (its trap not set yet, or the client's pid not
    // kept yet) ended it at once, or stopped herdr first. herdr asks for the stop itself here, as it starts.
    writeFileSync(join(bin, 'herdr'), `#!/bin/sh\ntrap 'if [ -f "${dir}/client.done" ] || [ ! -f "${dir}/client.up" ]; then echo after > "${dir}/herdr.stop"; else echo before > "${dir}/herdr.stop"; fi; exit 0' TERM\nkill -TERM $PPID\nwhile :; do sleep 0.05; done\n`);
    writeFileSync(join(bin, 'node'), `#!/bin/sh\ntrap 'sleep 0.3; touch "${dir}/client.done"; exit 0' TERM\ntouch "${dir}/client.up"\nwhile :; do sleep 0.05; done\n`);
    const child = spawn('sh', [SCRIPT], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: tmp } });
    expect(await new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))).toBe(0);
    for (let i = 0; i < 40 && !existsSync(join(dir, 'herdr.stop')); i++) await new Promise((r) => setTimeout(r, 50));
    expect(read('herdr.stop').trim()).toBe('after');
  });
});
