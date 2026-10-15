// The job's own container runtime against real rootless Podman (issues #1295, #1371, design.md "Sandboxes are fresh and
// leave nothing"): what a job makes in its runtime — a volume, a network, a container — carries its job label, and its reap
// leaves none of it; a job set up after it sees none of it. It runs only where a real podman works in a runtime dir of a
// test's own (a probe at load); elsewhere it is skipped. The user's runtime dir is a stand-in, so the host's Podman is never
// touched. No image is pulled: the container is made from an empty image built here (`podman image import`).
//
// Feature: a job's runtime leaves nothing
//   Scenario: the reap removes the job's containers, volumes and networks, and its storage
//     Given a job's runtime, and a volume, a network and a container the job made in it
//     When the job is reaped
//     Then no storage, runtime dir or network config of the job's is left
//     And a runtime set up again for a job of the same id lists no volume, network or container
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readReap, reapArgv } from '../../src/client/reap.ts';
import { runtimeCommand, runtimeSetupArgv } from '../../src/client/job-runtime.ts';

const JOB = 'job-1371-podman';
// The real podman, never a guard of a job that runs these tests (its guard is first on that job's PATH).
const PATH = `/usr/bin${delimiter}/bin`;

interface Seat { root: string; host: string; scratch: string; env: NodeJS.ProcessEnv }

function seat(): Seat {
  const root = mkdtempSync(join(tmpdir(), 'hopper-jrp-'));
  const host = join(root, 'run');
  const scratch = join(root, 'work', '.worktrees', '@scratch', JOB);
  mkdirSync(host, { mode: 0o700 });
  mkdirSync(scratch, { recursive: true });
  return { root, host, scratch, env: { HOME: root, PATH, XDG_RUNTIME_DIR: host } };
}

/** A job's shell: the runtime command, then `script` in the same shell. */
const inJobShell = (s: Seat, script: string): { status: number | null; stdout: string; stderr: string } => {
  const r = spawnSync('sh', ['-c', `${runtimeCommand(JOB, s.scratch, false)} >/dev/null; ${script}`], { encoding: 'utf8', env: s.env, timeout: 120_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};
const setUp = (s: Seat): string => spawnSync(runtimeSetupArgv(JOB, s.scratch, false)[0]!, runtimeSetupArgv(JOB, s.scratch, false).slice(1), { encoding: 'utf8', env: s.env }).stdout.trim();
const reap = (s: Seat): ReturnType<typeof readReap> & { said: string } => {
  const [file, ...args] = reapArgv(JOB, s.scratch);
  const r = spawnSync(file!, args, { encoding: 'utf8', env: s.env, timeout: 300_000 });
  return { ...readReap(r.stdout) ?? { kept: [] }, said: `${r.stdout}${r.stderr}` };
};

/**
 * Stops what still runs from the stand-in user's runtime dir and removes the seat. The reap's pass over the user's own
 * runtime (issue #1120) runs podman there, and podman leaves its pause process: on a real machine it is the user's own.
 */
function leave(s: Seat): void {
  spawnSync('sh', ['-c', 'l=$(grep -lzxF "XDG_RUNTIME_DIR=$1" /proc/[0-9]*/environ 2>/dev/null | sed -n "s|^/proc/\\([0-9]*\\)/environ$|\\1|p"); [ -z "$l" ] || kill -KILL $l', 'leave', s.host]);
  rmSync(s.root, { recursive: true, force: true });
}

/** Whether a real podman works here in a job's runtime: set one up, ask it, reap it. */
function podmanWorks(): boolean {
  if (!existsSync('/usr/bin/podman')) return false;
  const s = seat();
  try {
    return setUp(s) === 'own' && inJobShell(s, 'podman info >/dev/null 2>&1').status === 0;
  } catch {
    return false;
  } finally {
    try { reap(s); } catch { /* the probe's own */ }
    leave(s);
  }
}

const WORKS = podmanWorks();

describe.skipIf(!WORKS)('a job\'s runtime leaves nothing, on real Podman (issue #1371)', () => {
  let s: Seat;
  beforeEach(() => { s = seat(); });
  afterEach(() => {
    try { reap(s); } catch { /* reaped already */ }
    leave(s);
  });

  it('the reap removes the job\'s container, volume and network, and its storage; a runtime set up again sees none of them', () => {
    expect(setUp(s)).toBe('own');
    const made = inJobShell(s, [
      'podman volume create marker-vol >/dev/null',
      'podman network create marker-net >/dev/null',
      // An empty image, so nothing is pulled: the container is made, never started.
      'tar -cf - -T /dev/null | podman image import - localhost/hopper-empty:1371 >/dev/null',
      'podman create --name marker-box --network marker-net -v marker-vol:/data localhost/hopper-empty:1371 /none >/dev/null',
      `podman volume ls -q --filter label=hopper.job=${JOB}`,
      `podman network ls -q --filter label=hopper.job=${JOB}`,
      `podman ps -a --format '{{.Names}}' --filter label=hopper.job=${JOB}`,
    ].join(' && '));
    expect(made.status, made.stderr).toBe(0);
    expect(made.stdout.trim().split('\n')).toEqual(['marker-vol', 'marker-net', 'marker-box']);

    const said = reap(s);
    expect(said.removed?.volumes ?? [], said.said).toContain('marker-vol');
    expect(said.removed?.containers ?? [], said.said).toHaveLength(1);
    const containers = join(s.scratch, 'containers');
    expect(existsSync(join(containers, 'storage'))).toBe(false);
    expect(existsSync(join(s.host, `hopper-runtime-${JOB}`))).toBe(false);
    expect(existsSync(join(containers, 'networks')) ? readdirSync(join(containers, 'networks')) : []).not.toContain('marker-net.json');

    expect(setUp(s)).toBe('own');
    const after = inJobShell(s, 'podman volume ls -q && podman network ls --format "{{.Name}}" && podman ps -aq && podman images -q');
    expect(after.status).toBe(0);
    expect(after.stdout.trim().split('\n').filter(Boolean)).toEqual(['podman']);
  });
});
