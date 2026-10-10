// Sandbox boxes the hopper launches (issue #603, design.md "Sandbox boxes the hopper launches"): Add machine → A
// sandbox box starts the box through the sandbox engine (rootless Podman), with a join code minted for it; the box
// joins as a client target whose `container` option names it. The hopper owns every box it launched — each carries
// its instance's label — and keeps them in step with the machines: a box no client target names, and no live join
// code waits for, is stopped and removed with its volume. At start too, so a box left by a machine removed while the
// hopper was down goes. A box it cannot remove is a cleanup problem, shown on Machines with the reason.
import type { BoxContainer, SandboxEngine } from '../domain/ports.ts';
import type { CleanupProblem, SandboxesView } from '../domain/types.ts';

/** The label on every box the hopper launches: its value is the hopper's instance id. */
export const BOX_LABEL = 'io.hopper.box';
/** The label naming the user whose box it is. */
export const USER_LABEL = 'io.hopper.user';
/** The published image a box of an agent runs: its `box-<agent>` tag. */
export const BOX_IMAGE = 'ghcr.io/henningfutrell/hopper';
/** How often the hopper checks its boxes against the machines. */
export const RECONCILE_MS = 10_000;

export interface SandboxesOptions {
  /** Undefined: no Podman socket is given to the hopper (HOPPER_PODMAN_SOCKET unset). */
  engine: SandboxEngine | undefined;
  /** This hopper's instance id: the value of the box label, so two hoppers on one Podman leave each other's boxes. */
  instanceId: string;
  /** The network a box joins (`hopper_default` beside the compose hopper, `host` beside one on the host). */
  network: string;
  /** The URL a box dials the hopper at, from that network. */
  joinUrl: () => string;
  /** A join code for the user's box `container`, of `template` when it is one's. */
  mint(userId: string, container: string, template: string | undefined): string;
  /** The boxes a user's client targets name; undefined: no such user. */
  boxesOf(userId: string): Set<string> | undefined;
  /** The boxes a live join code waits for: launched, not joined yet. */
  waiting(): Set<string>;
  clock: { now(): Date };
  logger: { info(line: string): void; warn(line: string): void };
}

export interface Sandboxes {
  view(userId: string): Promise<SandboxesView>;
  /** Launch a box for the user: of a template (its image), else of the agent (the published box image). Throws with the reason. */
  launch(userId: string, o: { agent: string; template?: { name: string; image: string } }): Promise<{ container: string }>;
  /** Stop and remove every box no machine names: a box must be found so twice in a row, as a join's config write may lag one check. */
  reconcile(): Promise<void>;
  start(): void;
  stop(): void;
}

const NO_ENGINE = 'the hopper is given no Podman socket (HOPPER_PODMAN_SOCKET): it cannot start sandbox boxes itself. docs/deploy.md "Sandbox boxes the hopper starts"';
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createSandboxes(o: SandboxesOptions): Sandboxes {
  const problems = new Map<string, CleanupProblem & { userId: string }>();
  /** Boxes found with no machine at the last check: removed if the next check finds them so again. */
  let unclaimed = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  let engineDown: string | undefined;

  const owned = (): Promise<BoxContainer[]> => o.engine!.list({ [BOX_LABEL]: o.instanceId });

  const pass = async (): Promise<void> => {
    if (!o.engine) return;
    let boxes: BoxContainer[];
    try {
      boxes = await owned();
    } catch (e) {
      if (engineDown !== message(e)) o.logger.warn(`hopper: cannot list the sandbox boxes: ${(engineDown = message(e))}`);
      return;
    }
    engineDown = undefined;
    // Read after the list: a box that joined meanwhile is named here.
    const waiting = o.waiting();
    const now = new Set(boxes.map((b) => b.name));
    for (const name of problems.keys()) if (!now.has(name)) problems.delete(name);
    const next = new Set<string>();
    for (const box of boxes) {
      const userId = box.labels[USER_LABEL] ?? '';
      if (o.boxesOf(userId)?.has(box.name) || waiting.has(box.name)) continue;
      if (!unclaimed.has(box.name)) { next.add(box.name); continue; }
      try {
        await o.engine.remove(box.name, `${box.name}-home`);
        problems.delete(box.name);
        o.logger.info(`hopper: sandbox box ${box.name} removed: no machine names it`);
      } catch (e) {
        const reason = message(e);
        if (problems.get(box.name)?.reason !== reason) o.logger.warn(`hopper: cannot remove the sandbox box ${box.name}: ${reason}`);
        problems.set(box.name, { container: box.name, reason, at: o.clock.now().toISOString(), userId });
        next.add(box.name);
      }
    }
    unclaimed = next;
  };

  const reconcile = (): Promise<void> => (running ??= pass().finally(() => { running = undefined; }));

  return {
    async view(userId) {
      const problem = o.engine ? await o.engine.problem() : NO_ENGINE;
      return {
        launch: problem === undefined ? { available: true } : { available: false, problem },
        problems: [...problems.values()].filter((p) => p.userId === userId).map(({ userId: _u, ...p }) => p),
      };
    },

    async launch(userId, l) {
      if (!o.engine) throw new Error(NO_ENGINE);
      const problem = await o.engine.problem();
      if (problem) throw new Error(problem);
      const base = `hopper-sandbox-${l.template?.name ?? l.agent}`;
      const taken = await o.engine.names();
      let name = base;
      for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
      const code = o.mint(userId, name, l.template?.name);
      const spec = {
        name, image: l.template?.image ?? `${BOX_IMAGE}:box-${l.agent}`, network: o.network, volume: `${name}-home`,
        env: { HOPPER_CLIENT_NAME: name, HOPPER_JOIN: `${o.joinUrl()}#${code}` },
        labels: { [BOX_LABEL]: o.instanceId, [USER_LABEL]: userId },
      };
      try {
        await o.engine.launch(spec);
      } catch (e) {
        // Nothing half made is left: a box that did not start is removed, its volume too.
        await o.engine.remove(name, spec.volume).catch(() => {});
        throw e;
      }
      o.logger.info(`hopper: sandbox box ${name} started (${spec.image}); it joins as a machine`);
      return { container: name };
    },

    reconcile,
    start() {
      if (!o.engine || timer) return;
      void reconcile();
      timer = setInterval(() => void reconcile(), RECONCILE_MS);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
