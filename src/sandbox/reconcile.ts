// Keeping the boxes in step (issue #708), from the sandbox records, every 10 s and at start. Per record: past its time
// limit, it is stopped and removed at once; its container gone, the record goes; a machine names it, it is `ready` (its
// client reported back); a live join code waits for it, it stays `starting`; else it is idle, and removed once it is
// found so twice in a row (a join's config write may lag one check). A user whose machines cannot be read now keeps all
// their boxes. A container with the hopper's label and no record (a box from before the records, or a launch cut off)
// is taken on as a record when a machine names it, else removed the same way. Removing keeps the home volume unless the
// record says otherwise: it may hold an agent's sign-in. One pass checks one runtime: the hopper's own, or one user's
// client target's (the remote runtime), each against the records of the boxes on it.
import type { CleanupProblem } from '../domain/machines.ts';
import type { ContainerInfo, ContainerRuntime, SandboxRecord } from '../domain/sandboxes.ts';
import type { SandboxRepository } from '../domain/store.ts';
import { BOX_LABEL, USER_LABEL } from './launch.ts';

export interface ReconcileContext {
  runtime: ContainerRuntime;
  /** The machine the runtime is on: `local`, or a client target's name. */
  machine: string;
  /** A client target's runtime holds one user's boxes: theirs only. Undefined: every user's (the hopper's own). */
  userId?: string;
  repo: SandboxRepository;
  instanceId: string;
  now: Date;
  /** The boxes a user's client targets name; undefined: they cannot be read now. */
  boxesOf(userId: string): Set<string> | undefined;
  /** The boxes a live join code waits for at `now`. */
  waiting: Set<string>;
  launching: Set<string>;
  newId(): string;
  joinUrl: string;
  logger: { info(line: string): void; warn(line: string): void };
}

export type Problems = Map<string, CleanupProblem & { userId: string; machine: string }>;

/** One pass. `unclaimed`: the names found idle at the last pass; answers this pass's. */
export async function reconcilePass(c: ReconcileContext, problems: Problems, unclaimed: Set<string>): Promise<Set<string>> {
  const ours = (r: { machine: string; userId: string }): boolean => r.machine === c.machine && (c.userId === undefined || r.userId === c.userId);
  const labels = { [BOX_LABEL]: c.instanceId, ...(c.userId !== undefined ? { [USER_LABEL]: c.userId } : {}) };
  const containers = new Map((await c.runtime.list(labels)).map((x) => [x.name, x]));
  const next = new Set<string>();
  for (const [name, p] of problems) if (ours(p) && !containers.has(name)) problems.delete(name);

  const remove = async (name: string, id: string, userId: string, volume: string | undefined, why: string, recordId?: string): Promise<void> => {
    try {
      await c.runtime.stop(id);
      await c.runtime.remove(id);
      if (volume) await c.runtime.removeVolume(volume);
      if (recordId) c.repo.remove(recordId);
      problems.delete(name);
      c.logger.info(`hopper: sandbox box ${name} removed: ${why}`);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      if (problems.get(name)?.reason !== reason) c.logger.warn(`hopper: cannot remove the sandbox box ${name}: ${reason}`);
      problems.set(name, { container: name, reason, at: c.now.toISOString(), userId, machine: c.machine });
      next.add(name);
    }
  };
  /** Idle: removed when it was idle at the last pass too. */
  const idle = async (name: string, act: () => Promise<void>): Promise<void> => {
    if (unclaimed.has(name)) await act();
    else next.add(name);
  };

  const recorded = new Set<string>();
  for (const r of c.repo.list().filter(ours)) {
    recorded.add(r.name);
    if (c.launching.has(r.id)) continue;
    const box = containers.get(r.name);
    const volume = r.keepHome ? undefined : r.volume;
    if (r.expiresAt !== undefined && Date.parse(r.expiresAt) <= c.now.getTime()) {
      if (box) await remove(r.name, box.id, r.userId, volume, 'its time limit passed', r.id);
      else c.repo.remove(r.id);
      continue;
    }
    if (!box) {
      c.repo.remove(r.id);
      c.logger.warn(`hopper: sandbox box ${r.name} is gone: its record is removed`);
      continue;
    }
    const names = c.boxesOf(r.userId);
    if (names === undefined) continue;
    if (names.has(r.name)) {
      if (r.state !== 'ready') c.repo.update({ ...r, state: 'ready' });
      continue;
    }
    if (c.waiting.has(r.name)) continue;
    await idle(r.name, () => remove(r.name, box.id, r.userId, volume, 'no machine names it', r.id));
  }

  for (const box of containers.values()) {
    if (recorded.has(box.name)) continue;
    const userId = box.labels[USER_LABEL] ?? '';
    const names = c.boxesOf(userId);
    if (names === undefined || c.waiting.has(box.name)) continue;
    if (names.has(box.name)) {
      c.repo.add(adopted(c, box, userId));
      c.logger.info(`hopper: sandbox box ${box.name} has no record: taken on, as its machine names it`);
      continue;
    }
    await idle(box.name, () => remove(box.name, box.id, userId, undefined, 'no machine names it, and no record holds it'));
  }
  return next;
}

/** The record of a box from before the records: what its labels and the runtime say, no limits known, no time limit. */
function adopted(c: ReconcileContext, box: ContainerInfo, userId: string): SandboxRecord {
  return {
    id: c.newId(), userId, name: box.name, agent: /:box-(.+)$/.exec(box.image)?.[1] ?? 'claude', image: box.image, params: { secrets: [], cpus: 0, memoryMb: 0 },
    runtime: c.runtime.kind, machine: c.machine, containerId: box.id, volume: `${box.name}-home`, keepHome: true, state: 'ready',
    createdAt: c.now.toISOString(), address: c.joinUrl,
  };
}
