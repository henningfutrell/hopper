// The reap of a scratch dir that holds files of a job's user namespace (issue #2685), against real rootless Podman: a test
// Postgres's data dir, or the layers of a storage whose runtime and config are gone. Their dirs belong to sub-UIDs, so
// neither a plain remove nor one made writable first removes them, and the sweep tried each such dir until its attempts
// ran out. It runs only where a real podman makes a user namespace here (a probe at load); elsewhere it is skipped. The
// user's runtime dir and home are a test's own, so the host's Podman is never touched.
//
// Feature: a scratch dir with files of the job's user namespace is removed
//   Scenario: the job's runtime dir is gone, and no runtime config is left
//     Given a scratch dir that holds a dir and a file owned by a sub-UID, and no runtime dir of the job's
//     When the job is reaped
//     Then the scratch dir is gone, and the reap names nothing left
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readReap, reapArgv } from '../../src/client/reap.ts';

const JOB = 'job-2685-userns';
// The real podman, never a guard of a job that runs these tests (its guard is first on that job's PATH).
const PATH = `/usr/bin${delimiter}/bin`;

interface Seat { root: string; host: string; scratch: string; env: NodeJS.ProcessEnv }

function seat(): Seat {
  const root = mkdtempSync(join(tmpdir(), 'hopper-rus-'));
  const host = join(root, 'run');
  const scratch = join(root, 'work', '.worktrees', '@scratch', JOB);
  mkdirSync(host, { mode: 0o700 });
  mkdirSync(scratch, { recursive: true });
  return { root, host, scratch, env: { HOME: root, PATH, XDG_RUNTIME_DIR: host } };
}

/** Makes `dir` with a file in it, both owned by the user namespace's uid 1 (a sub-UID on the host). */
const owned = (s: Seat, dir: string): { status: number | null; stderr: string } => spawnSync('podman', ['unshare', 'sh', '-c',
  'mkdir -p "$1/inner" && touch "$1/inner/f" && chown -R 1:1 "$1" && chmod 700 "$1" "$1/inner"', 'owned', dir], { encoding: 'utf8', env: s.env, timeout: 60_000 });

/** Stops what runs with the seat's runtime dir (podman's pause process), then removes the seat, as the namespace's root. */
function leave(s: Seat): void {
  spawnSync('podman', ['unshare', 'rm', '-rf', s.root], { env: s.env, timeout: 60_000 });
  spawnSync('sh', ['-c', 'l=$(grep -lzxF "XDG_RUNTIME_DIR=$1" /proc/[0-9]*/environ 2>/dev/null | sed -n "s|^/proc/\\([0-9]*\\)/environ$|\\1|p"); [ -z "$l" ] || kill -KILL $l', 'leave', s.host]);
  rmSync(s.root, { recursive: true, force: true });
}

/** Whether a real podman makes a user namespace here with a sub-UID in it. */
function userNamespaceWorks(): boolean {
  if (!existsSync('/usr/bin/podman')) return false;
  const s = seat();
  try {
    return owned(s, join(s.scratch, 'probe')).status === 0;
  } catch {
    return false;
  } finally {
    leave(s);
  }
}

const WORKS = userNamespaceWorks();

describe.skipIf(!WORKS)('a scratch dir with files of the job\'s user namespace (issue #2685)', () => {
  let s: Seat;
  beforeEach(() => { s = seat(); });
  afterEach(() => leave(s));

  const reap = (): ReturnType<typeof readReap> & { said: string } => {
    const [file, ...args] = reapArgv(JOB, s.scratch);
    const r = spawnSync(file!, args, { encoding: 'utf8', env: s.env, timeout: 300_000 });
    return { ...readReap(r.stdout) ?? { kept: [] }, said: `${r.stdout}${r.stderr}` };
  };

  it('removes a test database\'s data dir, with no runtime dir of the job\'s', () => {
    const made = owned(s, join(s.scratch, 'pgdata'));
    expect(made.status, made.stderr).toBe(0);
    expect(existsSync(join(s.host, `hopper-runtime-${JOB}`))).toBe(false);

    const said = reap();
    expect(said.left, said.said).toBeUndefined();
    expect(existsSync(s.scratch)).toBe(false);
  });

  it('removes the layers of a storage whose runtime config is gone', () => {
    const made = owned(s, join(s.scratch, 'containers', 'storage', 'overlay', 'c3dc5097', 'diff'));
    expect(made.status, made.stderr).toBe(0);

    const said = reap();
    expect(said.left, said.said).toBeUndefined();
    expect(existsSync(s.scratch)).toBe(false);
  });
});
