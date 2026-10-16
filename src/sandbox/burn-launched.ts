// Burning the boxes the hopper launched before (issue #1349): a sandbox does one step and is burned, and none joins as a
// machine, so the hopper launches no box any more. A box an older build launched (it carries BOX_LABEL, and may have a
// sandbox record) is stopped and removed with its home volume, and its record goes once its box is gone. One pass burns on
// one runtime: the hopper's own, or one user's client target's (the remote runtime), each against the records on it. A box
// it cannot remove is a cleanup problem, shown on Machines, until a pass removes it.
import type { CleanupProblem } from '../domain/machines.ts';
import type { ContainerRuntime } from '../domain/sandboxes.ts';
import type { SandboxRepository } from '../domain/store.ts';
import { BOX_LABEL, USER_LABEL } from './owned.ts';

export interface BurnContext {
  runtime: ContainerRuntime;
  /** The machine the runtime is on: `local`, or a client target's name. */
  machine: string;
  /** A client target's runtime holds one user's boxes: theirs only. Undefined: every user's (the hopper's own). */
  userId?: string;
  repo: Pick<SandboxRepository, 'list' | 'remove'>;
  instanceId: string;
  now: Date;
  logger: { info(line: string): void; warn(line: string): void };
}

export type Problems = Map<string, CleanupProblem & { userId: string; machine: string }>;

/** One pass on one runtime: each launched box there burned, and each record of a box that is gone removed. */
export async function burnLaunched(c: BurnContext, problems: Problems): Promise<void> {
  const ours = (r: { machine: string; userId: string }): boolean => r.machine === c.machine && (c.userId === undefined || r.userId === c.userId);
  const labels = { [BOX_LABEL]: c.instanceId, ...(c.userId !== undefined ? { [USER_LABEL]: c.userId } : {}) };
  const left = new Set<string>();
  for (const box of await c.runtime.list(labels)) {
    const userId = box.labels[USER_LABEL] ?? '';
    try {
      // A box stuck "Stopping" refuses the stop; the remove is forced, so it takes the box all the same.
      await c.runtime.stop(box.id).catch(() => undefined);
      await c.runtime.remove(box.id);
      // Its home goes with it: no box of that name starts again. A home the runtime keeps, the sweep of homes tries again.
      await c.runtime.removeVolume(`${box.name}-home`).catch(() => {});
      problems.delete(box.name);
      c.logger.info(`hopper: sandbox box ${box.name} burned: a sandbox never joins as a machine`);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      if (problems.get(box.name)?.reason !== reason) c.logger.warn(`hopper: cannot burn the sandbox box ${box.name}: ${reason}`);
      problems.set(box.name, { container: box.name, reason, at: c.now.toISOString(), userId, machine: c.machine });
      left.add(box.name);
    }
  }
  for (const [name, p] of problems) if (ours(p) && !left.has(name)) problems.delete(name);
  for (const r of c.repo.list().filter(ours)) if (!left.has(r.name)) c.repo.remove(r.id);
}
