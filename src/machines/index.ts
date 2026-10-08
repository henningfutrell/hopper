// MachineSource adapters: `local`, this machine (reached through the `local` machine-source plugin),
// the attached machines (ssh, container and client targets, reached through the target pool), and the
// ssh targets ~/.ssh/config names.
import { homedir, hostname } from 'node:os';
import type { MachineSource } from '../domain/ports.ts';
import type { DiskReading, DiskThresholds, SweepSettings } from '../domain/machines.ts';
import { diskAt, judged } from './disk.ts';
import { DEFAULT_WORK_TREE, makeWorkTree } from '../client/work-tree.ts';

/** How often this machine's herdr session is checked, and started when it is not running. */
const SESSION_EVERY_MS = 30000;

export function createLocalMachineSource(o: {
  maxLanes: number;
  /** Lanes kept for jobs pinned to it (issue #372). */
  reservedLanes?: number;
  /** The executors registered now; asked on every list(). */
  executors: () => string[];
  id?: string;
  label?: string;
  /** The herdr session jobs here run in (issue #260); absent: the herdr-claude instance's own. */
  session?: string;
  /** Its jobs' work tree (issues #324, #361); absent: the jobs directory. Made and checked in the background, at most once per 30 s. */
  workTree?: string;
  /** Starts that session when it is not running. Called in the background, at most once per 30 s; list() never waits for it. */
  ensureSession?: () => Promise<unknown>;
  logger?: { info(line: string): void; warn(line: string): void };
  now?: () => number;
  /** Its disk (issue #401); default the filesystem of this process's home, read at every list(). */
  disk?: () => DiskReading | undefined;
  /** When its disk is low (issue #410), read at every list(); default 5 GiB and 10% free. */
  diskLow?: () => DiskThresholds | undefined;
  /** How the sweep treats it (issue #410), read at every list(); default every 10 minutes, scratch dirs after 24 hours. */
  sweep?: () => SweepSettings | undefined;
}): MachineSource {
  const disk = o.disk ?? (() => diskAt(homedir()));
  const now = o.now ?? Date.now;
  // Issue #361: the work tree is made here before a job is routed here; what is wrong with it is said.
  let checkedAt = -Infinity;
  let workTreeProblem: string | undefined;
  const check = (): void => {
    if (now() - checkedAt < SESSION_EVERY_MS) return;
    checkedAt = now();
    setImmediate(() => {
      const problem = makeWorkTree(o.workTree ?? DEFAULT_WORK_TREE, homedir());
      if (problem && problem !== workTreeProblem) o.logger?.warn(`hopper: this machine takes no new job: ${problem}`);
      workTreeProblem = problem;
    });
  };
  let last = -Infinity;
  let inFlight = false;
  let said: string | undefined;
  const ensure = (): void => {
    if (!o.ensureSession || inFlight || now() - last < SESSION_EVERY_MS) return;
    inFlight = true;
    last = now();
    o.ensureSession().then(
      (r) => {
        if (r === 'started') o.logger?.info(`hopper: started herdr session ${o.session} on this machine`);
        said = undefined;
      },
      (e: unknown) => {
        const line = `hopper: this machine's herdr session ${o.session} is not running and could not be started: ${e instanceof Error ? e.message : String(e)}`;
        if (line !== said) o.logger?.warn((said = line));
      },
    ).finally(() => { inFlight = false; });
  };
  return {
    list: async () => {
      ensure();
      const read = disk();
      const d = read && judged(read, o.diskLow?.());
      const sweep = o.sweep?.();
      check();
      return [
        {
          id: o.id ?? 'local',
          label: o.label ?? hostname(),
          maxLanes: o.maxLanes,
          ...(o.reservedLanes !== undefined ? { reservedLanes: o.reservedLanes } : {}),
          online: true,
          executors: [...o.executors()],
          ...(o.session ? { herdr: { session: o.session } } : {}),
          ...(o.workTree !== undefined ? { workTree: o.workTree } : {}),
          ...(d ? { disk: d } : {}),
          ...(sweep ? { sweep } : {}),
          ...(workTreeProblem ? { workTreeProblem } : {}),
        },
      ];
    },
  };
}

export { createAttachedMachineSource, createTargetPool, hostKeyFingerprint, hostKeyOffer, probeClient, probeContainer, knownHostKey, scanHostKey, probeHerdrOverSsh, probeSsh, resolveSshTarget, type MachineProbe, type ResolvedTarget } from './attached.ts';
export { diskAt, diskOf } from './disk.ts';
export { createClientReleaseKeeper, withClientWorkTree, type ClientReleaseKeeper } from './client-release.ts';
export { readSshTargets, type SshTargets } from './ssh-config.ts';
export { isThisMachine, type ThisMachineDeps } from './this-machine.ts';
