// Issue #2489: a build tool's daemon (Gradle's, run from a JDK the job put in its scratch dir) idles for hours after its
// build. One that left the job's scope and environment is the job's all the same: its executable is in the job's scratch
// dir, so the reap stops it. Run for real: a real shell and real processes.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REAP_DONE, reapArgv } from '../../src/client/reap.ts';

const JOB = 'job-2489-abcdef', OTHER = 'job-2489-other';

let root: string;
const children: ChildProcess[] = [];

const scratchOf = (jobId: string): string => join(root, 'work', '.worktrees', '@scratch', jobId);

/** A process run from a copy of sleep under `dir`, as a JDK the job put there runs: its own session, no job id. */
function inScratch(dir: string): ChildProcess {
  const bin = join(dir, 'jdk', 'bin');
  mkdirSync(bin, { recursive: true });
  copyFileSync(execFileSync('sh', ['-c', 'command -v sleep'], { encoding: 'utf8' }).trim(), join(bin, 'sleep'));
  chmodSync(join(bin, 'sleep'), 0o755);
  const env = { ...process.env };
  delete env.HOPPER_JOB_ID;
  const p = spawn(join(bin, 'sleep'), ['300'], { detached: true, stdio: 'ignore', env });
  p.unref();
  children.push(p);
  return p;
}

const alive = (pid: number): boolean => {
  try {
    // A zombie still answers kill 0; its state in /proc says it is gone.
    process.kill(pid, 0);
    return !/^\d+ \(.*\) Z/.test(execFileSync('cat', [`/proc/${pid}/stat`], { encoding: 'utf8' }));
  } catch {
    return false;
  }
};

const reap = (jobId: string, scratch: string): string => {
  const [file, ...args] = reapArgv(jobId, scratch);
  return execFileSync(file!, args, { encoding: 'utf8', timeout: 30000 });
};

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jh-reap-exe-')); });

afterEach(() => {
  for (const c of children.splice(0)) if (c.pid && alive(c.pid)) process.kill(c.pid, 'SIGKILL');
  rmSync(root, { recursive: true, force: true });
});

describe.runIf(existsSync('/proc/self/exe'))('the reap and a process run from the job\'s scratch dir (issue #2489)', () => {
  it('stops it, though it does not carry the job\'s id; never one run from another job\'s scratch dir', () => {
    const own = inScratch(scratchOf(JOB));
    const theirs = inScratch(scratchOf(OTHER));
    expect(reap(JOB, scratchOf(JOB))).toContain(REAP_DONE);
    expect(alive(own.pid!)).toBe(false);
    expect(alive(theirs.pid!)).toBe(true);
  });

  it('stops nothing by its executable when the reap names no scratch dir (a parked job\'s)', () => {
    const own = inScratch(scratchOf(JOB));
    expect(reap(JOB, '')).toContain(REAP_DONE);
    expect(alive(own.pid!)).toBe(true);
  });
});
