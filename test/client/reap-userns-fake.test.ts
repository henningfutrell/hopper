// The reap's removal in the user's own user namespace (issue #2685), with stand-ins on PATH: an `rm` that cannot remove the
// job's files but in that namespace, a `podman` whose `unshare` makes it and fails under no-new-privileges (as newuidmap
// does), and a `systemd-run` that runs its command outside the caller's no-new-privileges, as the user's systemd does. The
// real namespace is reap-userns.test.ts; this one runs anywhere, and checks which way the reap goes.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readReap, reapArgv } from '../../src/client/reap.ts';

const JOB = 'job-2685-fake';

let root: string, bin: string, scratch: string, log: string;

const script = (name: string, body: string): void => {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hopper-rusf-'));
  bin = join(root, 'bin');
  scratch = join(root, 'work', '.worktrees', '@scratch', JOB);
  log = join(root, 'calls');
  mkdirSync(bin);
  mkdirSync(join(scratch, 'pgdata', 'inner'), { recursive: true });
  writeFileSync(join(scratch, 'pgdata', 'inner', 'f'), 'x');
  writeFileSync(log, '');
  // Files of the job's namespace: no remove of the scratch dir goes through outside it.
  script('rm', `case "$*" in *${JOB}*) [ -n "$IN_NS" ] || exit 1;; esac; exec /bin/rm "$@"`);
  script('podman', [
    `printf 'podman %s\\n' "$*" >> ${log}`,
    '[ "$1" = unshare ] || exit 125; shift;',
    'grep -q "^NoNewPrivs:[[:space:]]*1" /proc/self/status && [ -z "$OUTSIDE" ] && { echo "newuidmap: Could not set caps" >&2; exit 125; };',
    'IN_NS=1 exec "$@"',
  ].join('\n'));
  script('systemd-run', [
    `printf 'systemd-run %s\\n' "$*" >> ${log}`,
    'while [ $# -gt 0 ]; do case $1 in --*) shift;; *) break;; esac; done;',
    'OUTSIDE=1 exec "$@"',
  ].join('\n'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const reap = (nnp: boolean): ReturnType<typeof readReap> => {
  const [file, ...args] = reapArgv(JOB, scratch);
  const argv = nnp ? ['setpriv', '--no-new-privs', file!, ...args] : [file!, ...args];
  const out = execFileSync(argv[0]!, argv.slice(1), { encoding: 'utf8', timeout: 60_000, env: { HOME: root, PATH: `${bin}:/usr/bin:/bin`, XDG_RUNTIME_DIR: join(root, 'run') } });
  return readReap(out);
};
const calls = (): string[] => readFileSync(log, 'utf8').split('\n').filter((l) => / unshare rm /.test(l));
const startsFree = !/^NoNewPrivs:\s*1/m.test(readFileSync('/proc/self/status', 'utf8'));

describe.skipIf(!existsSync('/usr/bin/setpriv'))('the reap removes files of the job\'s namespace through podman (issue #2685)', () => {
  it.skipIf(!startsFree)('removes the scratch dir in the namespace, with no systemd', () => {
    expect(reap(false)?.left).toBeUndefined();
    expect(existsSync(scratch)).toBe(false);
    expect(calls()).toEqual([`podman unshare rm -rf -- ${scratch}`]);
  });

  it('under no-new-privileges, removes it through the user\'s systemd', () => {
    expect(reap(true)?.left).toBeUndefined();
    expect(existsSync(scratch)).toBe(false);
    expect(calls()).toEqual([`podman unshare rm -rf -- ${scratch}`, expect.stringMatching(/^systemd-run --user .* unshare rm -rf -- /), `podman unshare rm -rf -- ${scratch}`]);
  });

  it('removes in the namespace only the job\'s own scratch dir, never a worktree', () => {
    const tree = join(root, 'work', '.worktrees', 'hopper', JOB);
    mkdirSync(tree, { recursive: true });
    const said = reap(true);
    expect(existsSync(scratch)).toBe(false);
    expect(said?.left).toEqual([tree]);
    expect(calls().every((l) => l.endsWith(`-- ${scratch}`))).toBe(true);
  });
});
