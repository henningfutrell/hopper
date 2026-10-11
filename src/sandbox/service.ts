// The sandbox module (issue #708, design.md "Sandbox boxes the hopper launches"): the one owner of the life of the
// sandbox boxes the hopper starts. Everything that creates, inspects, stops or removes one goes through it: the launch
// (Add machine → A sandbox box, POST /ui/api/machines/sandbox), the reconcile pass (every 10 s and at start), and the
// view (GET /api/sandboxes). It drives one container runtime (src/sandbox/runtime.ts picks it) and keeps a sandbox
// record per box (the instance's `sandboxes` table). A box it cannot remove is a cleanup problem, shown on Machines.
import { randomUUID } from 'node:crypto';
import type { SandboxesView } from '../domain/machines.ts';
import type { ContainerRuntime } from '../domain/sandboxes.ts';
import type { SandboxRepository } from '../domain/store.ts';
import type { ProbeCatalog } from '../domain/read-only-check.ts';
import { createCheckPass, type CheckTemplates } from './check.ts';
import { runFlags } from './flags.ts';
import { launchBox, type LaunchRequest } from './launch.ts';
import { DEFAULT_LIMITS } from './params.ts';
import { HOPPER_PROBES } from './probes.ts';
import { reconcilePass, type Problems } from './reconcile.ts';

export { BOX_IMAGE, BOX_LABEL, LaunchRefused, USER_LABEL, type LaunchRequest } from './launch.ts';
export { usersTemplates } from './check.ts';

/** The network the release compose.yaml makes and names (issue #711): the same name whatever the project is called. */
export const COMPOSE_NETWORK = 'hopper_default';

/**
 * The hopper's network (issues #708, #711): HOPPER_SANDBOX_NETWORK, else the compose network for a hopper in its
 * container, `host` for one on the host. The boxes it starts join it; a machine off it is shown the command that joins it.
 */
export const hopperNetwork = (c: { sandboxNetwork?: string | undefined; localMachine: boolean }): string => c.sandboxNetwork ?? (c.localMachine ? 'host' : COMPOSE_NETWORK);

/** How often the hopper checks its boxes against their records and the machines. */
export const RECONCILE_MS = 10_000;

export interface SandboxesOptions {
  /** Undefined: no runtime socket is given to the hopper (HOPPER_PODMAN_SOCKET, HOPPER_DOCKER_SOCKET unset). */
  runtime: ContainerRuntime | undefined;
  repo: SandboxRepository;
  /** This hopper's instance id: the value of the box label, so two hoppers on one runtime leave each other's boxes. */
  instanceId: string;
  /** The network a box joins (`hopper_default` beside the compose hopper, `host` beside one on the host). */
  network: string;
  /** The URL a box dials the hopper at, from that network: written into the record at launch. */
  joinUrl: () => string;
  /** A join code for the user's box `container`, of `template` when it is one's. */
  mint(userId: string, container: string, template: string | undefined): string;
  /** The boxes a user's client targets name; undefined: they cannot be read now. A user the instance lacks names none. */
  boxesOf(userId: string): Set<string> | undefined;
  /** The boxes a live join code waits for at `now`: launched, not joined yet. */
  waiting(now: Date): Set<string>;
  clock: { now(): Date };
  logger: { info(line: string): void; warn(line: string): void };
  /** The templates the read-only check reads, and where it keeps a check (issue #716). Absent: no check runs. */
  checks?: CheckTemplates;
  /** The probes of the read-only check; absent: the hopper's catalog (src/sandbox/probes.ts). */
  probes?: ProbeCatalog;
}

export interface Sandboxes {
  view(userId: string): Promise<SandboxesView>;
  /**
   * Launch a box for the user: of a template (its approved image, its parameters within its limits), else of the agent
   * (the published box image). Throws LaunchRefused before it starts anything; any other error: it did not start.
   */
  launch(userId: string, l: LaunchRequest): Promise<{ container: string }>;
  /** One reconcile pass, at `now` (default the clock's). */
  reconcile(now?: Date): Promise<void>;
  /** One read-only check pass (issue #716): each template that is due is checked; a pass that runs already is joined. */
  check(): Promise<void>;
  start(): void;
  stop(): void;
}

const NO_RUNTIME = 'the hopper is given no container runtime socket (HOPPER_PODMAN_SOCKET, or HOPPER_DOCKER_SOCKET): it cannot start sandbox boxes itself. docs/deploy.md "Sandbox boxes the hopper starts"';
/** The sandbox flags of the line Add machine shows: the boxes' own builder, with a box's default limits. */
const LINE = runFlags({ cpus: DEFAULT_LIMITS.cpus.default, memoryMb: DEFAULT_LIMITS.memoryMb.default }).join(' ');

export function createSandboxes(o: SandboxesOptions): Sandboxes {
  const problems: Problems = new Map();
  const launching = new Set<string>();
  let unclaimed = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  let runtimeDown: string | undefined;

  const pass = async (now: Date): Promise<void> => {
    if (!o.runtime) return;
    try {
      unclaimed = await reconcilePass({
        runtime: o.runtime, repo: o.repo, instanceId: o.instanceId, now, boxesOf: o.boxesOf, waiting: o.waiting(now), launching,
        newId: randomUUID, joinUrl: o.joinUrl(), logger: o.logger,
      }, problems, unclaimed);
      runtimeDown = undefined;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      if (runtimeDown !== reason) o.logger.warn(`hopper: cannot list the sandbox boxes: ${(runtimeDown = reason)}`);
    }
  };
  const reconcile = (now?: Date): Promise<void> => (running ??= pass(now ?? o.clock.now()).finally(() => { running = undefined; }));
  const checkPass = o.runtime && o.checks
    ? createCheckPass({ runtime: o.runtime, instanceId: o.instanceId, network: o.network, probes: o.probes ?? HOPPER_PROBES, clock: o.clock, logger: o.logger }, o.checks)
    : undefined;
  let checking: Promise<void> | undefined;
  const check = (): Promise<void> => (checking ??= (checkPass?.() ?? Promise.resolve())
    .catch((e: unknown) => o.logger.warn(`hopper: the read-only check pass failed: ${e instanceof Error ? e.message : String(e)}`))
    .finally(() => { checking = undefined; }));

  return {
    async view(userId) {
      const problem = o.runtime ? await o.runtime.problem() : NO_RUNTIME;
      return {
        launch: { available: problem === undefined, ...(problem !== undefined ? { problem } : {}), ...(o.runtime ? { runtime: o.runtime.kind } : {}) },
        line: LINE,
        boxes: o.repo.list().filter((r) => r.userId === userId).map(({ userId: _u, ...box }) => box),
        problems: [...problems.values()].filter((p) => p.userId === userId).map(({ userId: _u, ...p }) => p),
      };
    },

    async launch(userId, l) {
      if (!o.runtime) throw new Error(NO_RUNTIME);
      const problem = await o.runtime.problem();
      if (problem) throw new Error(problem);
      const record = await launchBox({
        runtime: o.runtime, repo: o.repo, instanceId: o.instanceId, network: o.network, joinUrl: o.joinUrl(), now: o.clock.now(),
        id: randomUUID(), mint: (container, template) => o.mint(userId, container, template), launching,
      }, userId, l);
      o.logger.info(`hopper: sandbox box ${record.name} started (${record.image}, ${o.runtime.kind}); it joins as a machine`);
      return { container: record.name };
    },

    reconcile,
    check,
    start() {
      if (!o.runtime || timer) return;
      void reconcile();
      void check();
      timer = setInterval(() => { void reconcile(); void check(); }, RECONCILE_MS);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
