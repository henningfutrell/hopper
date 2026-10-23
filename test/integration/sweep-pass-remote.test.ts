// One cleanup pass on a remote machine (issue #2494, design.md "Hopper's own disk use" → "Part 15"), through the real
// composition root and a real client target: the sweep surveys and reaps through the client's signed `/survey` and `/reap`,
// as on any machine it does not run on. Two jobs ended two days ago: one left only files, the other a repository with a
// commit no remote has. The pass removes the first one's scratch dir and worktree, keeps the second one's, and records
// one machine.sweep_passed event with the bytes it freed and why it kept the work.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { mintToken } from '../../src/client/signature.ts';
import type { Executor, MachineShell } from '../../src/domain/ports.ts';
import { clientShell } from '../../src/executors/machine-shell.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { startTestClient, type TestClient } from '../support/client.ts';
import { createManualSource } from '../support/manual-source.ts';
import { waitFor } from '../support/wait.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);
const MIB = 1024 ** 2;

const apps: TestApp[] = [];
let client: TestClient | undefined;
let root: string | undefined;
let cleanup: (() => void) | undefined;
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  await client?.stop();
  client = undefined;
  cleanup?.();
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

const git = (cwd: string, ...args: string[]): void => { execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'ignore' }); };

/**
 * Each run leaves its scratch dir and a job worktree in `work`, and finishes; a job whose payload says `unpushed` leaves a
 * repository with a commit no remote has (its payload names `unpushed`). Its own cleanup reaps nothing: only the sweep, on the client target, can.
 */
function createLeaver(work: string, shell: () => MachineShell): Executor {
  return {
    name: 'leaver',
    idempotent: false,
    validate: () => null,
    async run(ctx) {
      const scratch = join(work, '.worktrees', '@scratch', ctx.job.id);
      mkdirSync(scratch, { recursive: true });
      mkdirSync(join(work, '.worktrees', 'app', ctx.job.id), { recursive: true });
      writeFileSync(join(scratch, 'build.out'), Buffer.alloc(2 * MIB, 1));
      writeFileSync(join(work, '.worktrees', 'app', ctx.job.id, 'tree.out'), Buffer.alloc(MIB, 1));
      if (JSON.stringify(ctx.job.spec.payload).includes('unpushed')) {
        const repo = join(scratch, 'repo');
        mkdirSync(repo);
        git(repo, 'init', '-q');
        writeFileSync(join(repo, 'a.txt'), 'work');
        git(repo, 'add', 'a.txt');
        git(repo, 'commit', '-q', '-m', 'work');
      }
      ctx.saveState({ cwd: work });
      return { kind: 'finished', result: {} };
    },
    async cleanup() {},
    machineShell: () => shell(),
  };
}

describe.runIf(existsSync('/proc/self/environ'))('one cleanup pass on a remote machine (issue #2494)', () => {
  it('removes a clean ended job\'s dirs, keeps unpushed work, and records the pass with the bytes freed', async () => {
    root = mkdtempSync(join(tmpdir(), 'hopper-pass-'));
    const work = join(root, 'work');
    const token = mintToken();
    client = await startTestClient({ token: () => token, herdrBin: HERDR, session: 'hopper' });
    const shell = (): MachineShell => clientShell(client!.transport(token));
    const db = tempDbPath();
    cleanup = db.cleanup;
    const source = createManualSource();

    const first = await startTestApp({ dbPath: db.dbPath, source, seams: { executors: [createLeaver(work, shell)] } });
    apps.push(first);
    const clean = await first.pull({}, { executor: 'leaver' });
    await first.waitForStatus(clean.id, 'finished');
    const kept = await first.pull({ unpushed: true }, { executor: 'leaver' });
    await first.waitForStatus(kept.id, 'finished');
    await first.stop();
    apps.splice(0);

    // Two days old, so the sweep's age rule takes both jobs' dirs.
    const old = new Date(Date.now() - 48 * 3600_000);
    for (const id of [clean.id, kept.id]) for (const dir of [join(work, '.worktrees', '@scratch', id), join(work, '.worktrees', 'app', id)]) utimesSync(dir, old, old);

    const second = await startTestApp({ dbPath: db.dbPath, source, seams: { executors: [createLeaver(work, shell)] } });
    apps.push(second);
    const pass = await waitFor(async () => (await second.events()).find((e) => e.type === 'machine.sweep_passed'), { timeoutMs: 20000, what: 'the cleanup pass recorded' });
    expect(existsSync(join(work, '.worktrees', '@scratch', clean.id))).toBe(false);
    expect(existsSync(join(work, '.worktrees', 'app', clean.id))).toBe(false);
    expect(existsSync(join(work, '.worktrees', '@scratch', kept.id, 'repo'))).toBe(true);

    const data = pass.data as { removed: { kind: string; count: number; bytes?: number }[]; freedBytes: number; kept: { jobId: string; reasons?: Record<string, string[]> }[] };
    expect(data.removed).toEqual([{ kind: 'scratch', count: 1, bytes: expect.any(Number) }]);
    expect(data.removed[0]!.bytes).toBeGreaterThanOrEqual(3 * MIB);
    expect(data.freedBytes).toBe(data.removed[0]!.bytes);
    expect(data.kept).toEqual([{ jobId: kept.id, paths: [join(work, '.worktrees', '@scratch', kept.id, 'repo')], reasons: { [join(work, '.worktrees', '@scratch', kept.id, 'repo')]: ['unpushed'] } }]);
  }, 60000);
});
