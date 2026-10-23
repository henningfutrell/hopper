// What a job leaves (issue #2498), run for real on this machine. At a job's end, finished or failed, its cleanup's reap
// takes its tagged process, container and worktree. And the orphan reaper: a hopper stopped mid-job leaves a process that carries the job's id, a container
// labelled with it and a job worktree. Started again, the job fails and the sweep's real survey and reap of this machine
// reclaim all three. What carries no hopper tag, or the tag of a job this hopper does not know, stays: a plain process, a
// container with no label, a dir in the scratch root that is no job's, and another job's worktree. The container runtime
// is a fake first on the machine shell's PATH, so no real one is asked.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JOB_LABEL } from '../../src/client/reap.ts';
import { jobScratchOf } from '../../src/domain/job-layout.ts';
import type { ExecutionOutcome, Executor } from '../../src/domain/ports.ts';
import { localShell } from '../../src/executors/machine-shell.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createManualSource } from '../support/manual-source.ts';
import { waitFor } from '../support/wait.ts';

// The fake runtime: containers as lines `<id> <job id>` in $FAKE/containers, `-` for one with no label. It answers the
// lists by label, the label read and the removal; volumes, none.
const FAKE_RUNTIME = `#!/bin/sh
case "$1 $2" in
  "ps -aq") case $4 in label=${JOB_LABEL}) awk '$2 != "-" { print $1 }' "$FAKE/containers";; label=${JOB_LABEL}=*) awk -v j="\${4#label=${JOB_LABEL}=}" '$2 == j { print $1 }' "$FAKE/containers";; esac;;
  "inspect --format") case $3 in *Config.Image*) ;; *) shift 3; for i in "$@"; do awk -v i="$i" '$1 == i { print $2 }' "$FAKE/containers"; done;; esac;;
  "rm -f") shift 3; for i in "$@"; do grep -v "^$i " "$FAKE/containers" > "$FAKE/c.next"; mv "$FAKE/c.next" "$FAKE/containers"; done;;
esac
`;

const apps: TestApp[] = [];
const children: ChildProcess[] = [];
let cleanup: (() => void) | undefined;
let root: string | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  cleanup?.();
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

const alive = (p: ChildProcess): boolean => p.exitCode === null && p.signalCode === null;
const sleeper = (env: NodeJS.ProcessEnv): ChildProcess => {
  const p = spawn('sleep', ['300'], { detached: true, stdio: 'ignore', env });
  children.push(p);
  return p;
};

/** The machine shell of this machine, with the fake runtime first on its PATH. */
const shellOf = (fake: string): ReturnType<typeof localShell> => localShell({ FAKE: fake, XDG_RUNTIME_DIR: fake, PATH: `${fake}${delimiter}${process.env.PATH ?? ''}` });

/** What a run leaves: a process with the job's id, a container with its label, its scratch dir and a job worktree. */
function leave(jobId: string, work: string, fake: string): ChildProcess {
  const p = sleeper({ ...process.env, HOPPER_JOB_ID: jobId });
  writeFileSync(join(fake, 'containers'), `c0ffee01 ${jobId}\n`, { flag: 'a' });
  for (const dir of [join(work, '.worktrees', '@scratch', jobId), join(work, '.worktrees', 'app', jobId)]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'build.log'), 'x');
  }
  return p;
}

/** Not idempotent; each run leaves what `leave` makes, and runs until stopped. Its own cleanup reaps nothing: only the sweep can. */
function createLeaver(work: string, fake: string): Executor {
  return {
    name: 'leaver',
    idempotent: false,
    validate: () => null,
    run(ctx) {
      const p = leave(ctx.job.id, work, fake);
      ctx.saveState({ cwd: work, pid: p.pid });
      return new Promise<ExecutionOutcome>((resolve) => ctx.signal.addEventListener('abort', () => resolve({ kind: 'failed', error: 'aborted' }), { once: true }));
    },
    async cleanup() {},
    machineShell: (m) => (m.containerImage || m.client || m.ssh ? undefined : shellOf(fake)),
  };
}

/** Each run leaves what `leave` makes and ends with `outcome`; its cleanup is the machine's reap, as a real executor's. */
function createEnder(work: string, fake: string, outcome: ExecutionOutcome): Executor {
  return {
    name: 'ender',
    idempotent: false,
    validate: () => null,
    async run(ctx) {
      leave(ctx.job.id, work, fake);
      ctx.saveState({ cwd: work });
      return outcome;
    },
    cleanup: (job, o) => shellOf(fake).reap(job.id, jobScratchOf(work, job.id), o?.keepScratch === true),
    machineShell: (m) => (m.containerImage || m.client || m.ssh ? undefined : shellOf(fake)),
  };
}

/** A work tree and the fake runtime, with what is untagged or another job's: a container with no label and one of a job this hopper does not know. */
function setUp(): { work: string; fake: string } {
  root = mkdtempSync(join(tmpdir(), 'hopper-orphans-'));
  const work = join(root, 'work');
  const fake = join(root, 'fake');
  mkdirSync(fake);
  writeFileSync(join(fake, 'docker'), FAKE_RUNTIME, { mode: 0o755 });
  // A second runtime that answers nothing, so a real podman on this machine is never asked.
  writeFileSync(join(fake, 'podman'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  writeFileSync(join(fake, 'containers'), 'free01 -\nbeef0001 not-this-hoppers-job\n');
  return { work, fake };
}
const containersIn = (fake: string): string[] => readFileSync(join(fake, 'containers'), 'utf8').split('\n').filter(Boolean);

describe.runIf(existsSync('/proc/self/environ')).each([
  ['finished', { kind: 'finished', result: {} }],
  ['failed', { kind: 'failed', error: 'tests failed' }],
] as const)('at a job\'s end, %s (issue #2498)', (status, outcome) => {
  it('its cleanup leaves no process, container or worktree of the job; nothing untagged or another\'s is touched', async () => {
    const { work, fake } = setUp();
    const stranger = sleeper({ ...process.env, HOPPER_JOB_ID: 'not-this-hoppers-job' });
    const db = tempDbPath();
    cleanup = db.cleanup;
    const app = await startTestApp({ dbPath: db.dbPath, source: createManualSource(), seams: { executors: [createEnder(work, fake, outcome as ExecutionOutcome)] } });
    apps.push(app);
    const job = await app.pull({}, { executor: 'ender' });
    await app.waitForStatus(job.id, status);
    await waitFor(() => children.filter((c) => c !== stranger).every((c) => !alive(c)) && !containersIn(fake).some((l) => l.endsWith(` ${job.id}`)), { timeoutMs: 10000, what: 'the job\'s process and container removed by its cleanup' });
    expect(existsSync(jobScratchOf(work, job.id))).toBe(false);
    expect(existsSync(join(work, '.worktrees', 'app', job.id))).toBe(false);
    expect(alive(stranger)).toBe(true);
    expect(containersIn(fake)).toEqual(['free01 -', 'beef0001 not-this-hoppers-job']);
  });
});

describe.runIf(existsSync('/proc/self/environ'))('the orphan reaper (issue #2498)', () => {
  it('reclaims an ended job\'s tagged process, container and worktree; never what is untagged or another\'s', async () => {
    const { work, fake } = setUp();
    const strangerDir = join(work, '.worktrees', '@scratch', 'not-a-job');
    const strangerTree = join(work, '.worktrees', 'app', 'not-this-hoppers-job');
    for (const dir of [strangerDir, strangerTree]) mkdirSync(dir, { recursive: true });

    const db = tempDbPath();
    cleanup = db.cleanup;
    const source = createManualSource();
    const first = await startTestApp({ dbPath: db.dbPath, source, seams: { executors: [createLeaver(work, fake)] } });
    apps.push(first);
    const job = await first.pull({}, { executor: 'leaver' });
    await first.waitForStatus(job.id, 'running');
    await waitFor(() => children.length === 1);
    const left = children[0]!;
    const untagged = sleeper(Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'HOPPER_JOB_ID')));
    const stranger = sleeper({ ...process.env, HOPPER_JOB_ID: 'not-this-hoppers-job' });
    await first.stop();
    apps.splice(0);
    expect(alive(left)).toBe(true);

    // Two days old, so the sweep's age rule takes the ended job's scratch dir and worktree, and the stranger's too if it judged them.
    const scratch = join(work, '.worktrees', '@scratch', job.id);
    const tree = join(work, '.worktrees', 'app', job.id);
    const old = new Date(Date.now() - 48 * 3600_000);
    for (const dir of [scratch, tree, strangerDir, strangerTree]) utimesSync(dir, old, old);

    const second = await startTestApp({ dbPath: db.dbPath, source, seams: { executors: [createLeaver(work, fake)] } });
    apps.push(second);
    expect((await second.waitForStatus(job.id, 'failed')).error).toBe('interrupted by daemon restart');
    await waitFor(() => !alive(left) && !existsSync(scratch) && !existsSync(tree), { timeoutMs: 10000, what: 'the job\'s process, scratch dir and worktree reclaimed by the sweep' });
    await waitFor(() => !containersIn(fake).some((l) => l.startsWith('c0ffee01 ')), { timeoutMs: 10000, what: 'the job\'s container removed' });

    expect(alive(untagged)).toBe(true);
    expect(alive(stranger)).toBe(true);
    expect(containersIn(fake)).toEqual(['free01 -', 'beef0001 not-this-hoppers-job']);
    expect(existsSync(strangerDir)).toBe(true);
    expect(existsSync(strangerTree)).toBe(true);
  });
});
