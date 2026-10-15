// A machine for tests of what a running job asks the hopper (issues #563, #694): an executor whose jobs hold their lane
// until ended, keeping their credential files as real files under a root (the machine's disk, as the MachineShell port
// writes them), and the job's run of the script it was given — `hopper-gh` — with its variables and those files.
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Executor, MachineShell } from '../../src/domain/ports.ts';
import type { DiscoveryFacts } from '../../src/domain/types.ts';

const NOTHING: DiscoveryFacts = { path: ['/usr/bin'], bins: [{ dir: '/usr/bin', name: 'sh' }], versions: {}, aws: [], kube: [], credentials: { env: [], files: [] } };

/** A running job of the holder: the variables it runs with, and what ends it. */
export interface Held { env: Record<string, string>; end(): void }

/**
 * An executor whose jobs hold their lane until ended, keeping their credential files as real files under `root`
 * (the machine's disk, as the MachineShell port writes them).
 */
export function holder(root: string) {
  const held = new Map<string, Held>();
  /** What the reach check says on the machine (issue #695); the URLs it was asked for. */
  const reach: { unreached?: string; asked: string[] } = { asked: [] };
  const shell: MachineShell = {
    async reap() { return { kept: [] }; },
    async survey() { return { scopes: [], processes: [], scratch: [] }; },
    async keepCredential(_jobId, dir, file, content) {
      const path = join(root, dir, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, { mode: 0o600 });
    },
    async discover() { return NOTHING; },
    async reach(url) { reach.asked.push(url); return reach.unreached; },
  };
  const executor: Executor = {
    name: 'holder', idempotent: false, validate: () => null, machineShell: () => shell,
    async run(ctx) {
      const env = { ...(await ctx.credentials?.(`/work/.worktrees/@scratch/${ctx.job.id}`)) };
      // An abort (cancel, park, shutdown) returns at once, as the port asks: the daemon's stop does not wait it out.
      const aborted = await new Promise<boolean>((end) => {
        held.set(ctx.job.id, { env, end: () => end(false) });
        ctx.signal.addEventListener('abort', () => end(true), { once: true });
      });
      return aborted ? { kind: 'failed', error: 'aborted' } : { kind: 'finished', result: 'ended' };
    },
    resume: async () => ({ kind: 'failed', error: 'not resumed' }),
  };
  return { executor, held, reach };
}

export interface Run { code: number; stdout: string; stderr: string }

/** The job runs the script it was given, on its machine: its variables, its files under `root`. */
export function hopperGh(root: string, env: Record<string, string>, args: string[]): Promise<Run> {
  const onDisk = (v: string | undefined) => (v === undefined ? undefined : join(root, v));
  return new Promise((resolve) => {
    execFile('sh', [onDisk(env.HOPPER_GH)!, ...args], {
      env: { PATH: process.env.PATH, HOPPER_URL: env.HOPPER_URL, HOPPER_TOKEN_FILE: onDisk(env.HOPPER_TOKEN_FILE) } as NodeJS.ProcessEnv,
    }, (err, stdout, stderr) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr }));
  });
}

