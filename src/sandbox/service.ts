// The sandbox module (issue #708, design.md "Sandbox boxes the hopper launches"): the one owner of the life of the
// sandbox boxes the hopper starts. Everything that creates, inspects, stops or removes one goes through it: the launch
// (Add machine → A sandbox box, POST /ui/api/machines/sandbox), the reconcile pass (every 10 s and at start), and the
// view (GET /api/sandboxes). Once an hour the reconcile pass also removes the leftover box builds beside the hopper
// (leftover-builds.ts, issue #1120). A job's step runs in a sandbox of its own, a need box (need-box.ts), that the module
// burns after the step and keeps in the sandbox runs ledger (issue #1349): no machine, no lane, no record of a box that
// stays. The check pass's sweep burns any need box that outlives its step, and notes each burn in the ledger. It drives the container runtime beside the hopper, and a client target's own through its
// client (src/sandbox/runtime.ts places each box), and keeps a sandbox record per box (the instance's `sandboxes` table). A box it cannot remove is a cleanup problem, shown on Machines.
import { randomUUID } from 'node:crypto';
import type { SandboxesView } from '../domain/machines.ts';
import type { ContainerRuntime, SandboxRecord } from '../domain/sandboxes.ts';
import type { SandboxRepository } from '../domain/store.ts';
import type { ProbeCatalog } from '../domain/read-only-check.ts';
import { outcomeOf, type SandboxRun, type SandboxRunRepository } from '../domain/sandbox-runs.ts';
import { createCheckPass, type CheckTemplates } from './check.ts';
import { launchBox, type LaunchRequest } from './launch.ts';
import { removeLeftoverBuilds, LEFTOVER_PASS_MS } from './leftover-builds.ts';
import { launchScopeOf, type LaunchedProfile } from './params.ts';
import { HOPPER_PROBES } from './probes.ts';
import { reconcilePass, type Problems } from './reconcile.ts';
import { createPlacements, LOCAL, NO_RUNTIME, NO_RUNTIME_IN_CLUSTER, type ClientTargets } from './runtime.ts';
import { runNeedBox, NEED_LABEL, type NeedBox, type NeedBoxResult } from './need-box.ts';
import { sweepHomes } from './owned.ts';
import type { AgentCredentialOf } from './agent-credential.ts';
import type { AgentCredentialAsk } from '../vault/agent-credential.ts';

export { BOX_IMAGE, BOX_LABEL, LaunchRefused, SANDBOX_LABEL, USER_LABEL, type LaunchRequest } from './launch.ts';
export { usersTemplates } from './check.ts';
export { usersAgentCredentials } from './agent-credential.ts';
export { hopperAddress, ownContainer } from './address.ts';
export { cachedSandboxes } from './records.ts';

/** What each of the user's boxes was launched with, by its name (issue #708): the vault gives a box's jobs nothing else. */
export function launchScopes(records: SandboxRecord[], userId: string): Map<string, { secrets: string[]; profile?: LaunchedProfile }> {
  return new Map(records.filter((r) => r.userId === userId).flatMap((r) => { const s = launchScopeOf(r); return s ? [[r.name, s] as const] : []; }));
}

/** The network the release compose.yaml makes and names (issue #711): the same name whatever the project is called. */
export const COMPOSE_NETWORK = 'hopper_default';

/**
 * The hopper's network (issues #708, #711): HOPPER_SANDBOX_NETWORK, else the compose network for a hopper in its
 * container, `host` for one on the host. The boxes it starts join it; a machine off it is shown the command that joins it.
 */
export const hopperNetwork = (c: { sandboxNetwork?: string | undefined; localMachine: boolean }): string => c.sandboxNetwork ?? (c.localMachine ? 'host' : COMPOSE_NETWORK);

/** How often the hopper checks its boxes against their records and the machines, and runs their start checks. */
export const RECONCILE_MS = 10_000;
/** How long a launch waits for the box's start check to pass: the box reaches the hopper, or the launch fails. */
export const START_CHECK_MS = 30_000;
/** How many of a user's latest sandbox runs the view shows. */
export const RUNS_IN_VIEW = 50;

/** The run a need step's sandbox is (issue #1349): the job and the step it serves, and the template it is made of. */
export interface NeedRun { jobId: string; step: string; template: string }

export interface SandboxesOptions {
  /** Undefined: no runtime socket is given to the hopper (HOPPER_PODMAN_SOCKET, HOPPER_DOCKER_SOCKET unset). */
  runtime: ContainerRuntime | undefined;
  repo: SandboxRepository;
  /** The sandbox runs (issue #1349): each sandbox made for one step, from its start to its burn. */
  runs: SandboxRunRepository;
  /** This hopper's instance id: the value of the box label, so two hoppers on one runtime leave each other's boxes. */
  instanceId: string;
  /** The network a box joins (`hopper_default` beside the compose hopper, `host` beside one on the host). */
  network: string;
  /** The URL a box dials the hopper at, from that network, as configured: a box taken on from before the records. */
  joinUrl: () => string;
  /** The hopper runs in a Kubernetes pod (issue #1289): with no runtime, that is said, not a socket to give. */
  cluster?: boolean;
  /** Sets that URL at each launch from what the runtime says of the hopper (address.ts); absent: `joinUrl`. */
  address?: (runtime: ContainerRuntime) => Promise<string>;
  /** How long a launch waits for the box's start check to pass; default START_CHECK_MS. */
  startCheckMs?: number;
  /** A user's client target by name, for a box on it (the remote runtime); absent: boxes start only beside the hopper. */
  clients?: ClientTargets;
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
  /** The users' vaults, for a template's agent credential at launch (issue #708, part 10). Absent: no box gets one. */
  agentCredentials?: AgentCredentialOf;
}

export interface Sandboxes {
  view(userId: string): Promise<SandboxesView>;
  /**
   * Launch a box for the user: of a template (its approved image, its parameters within its limits), else of the agent
   * (the published box image); beside the hopper, or on the client target `machine` names. Throws LaunchRefused before
   * it starts anything; any other error: it did not start.
   */
  launch(userId: string, l: LaunchRequest): Promise<{ container: string }>;
  /**
   * Run one need step (issue #1007, need-box.ts): a one-shot box of the template, its credentials in its
   * environment, beside the hopper, else on a client target of the user's dialled in with a runtime there (as a read-only
   * check runs). The box is burned after the step, and the run kept in the ledger, `run` naming its job and step (issue
   * #1349). Never rejects: no place to run it, or a failure of its own, is `problem`.
   */
  needStep(userId: string, box: Omit<NeedBox, 'userId' | 'instanceId' | 'network'>, io: { log(chunk: string): void; signal: AbortSignal; pollMs?: number }, run: NeedRun): Promise<NeedBoxResult>;
  /** One reconcile pass, at `now` (default the clock's). */
  reconcile(now?: Date): Promise<void>;
  /** One read-only check pass (issue #716): each template that is due is checked; a pass that runs already is joined. */
  check(): Promise<void>;
  start(): void;
  /**
   * Ends the timer, then waits for a reconcile or check pass in flight: the hopper closes its database after this. A pass
   * that waits on a machine's link ends once the hopper closes its links.
   */
  stop(): Promise<void>;
}

export function createSandboxes(o: SandboxesOptions): Sandboxes {
  const problems: Problems = new Map();
  const launching = new Set<string>();
  let unclaimed = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  const down = new Map<string, string>();
  let buildsAt = -Infinity;
  const noRuntime = o.cluster ? NO_RUNTIME_IN_CLUSTER : NO_RUNTIME;
  const places = createPlacements({ local: o.runtime, network: o.network, joinUrl: o.joinUrl, noRuntime, ...(o.address ? { address: o.address } : {}), ...(o.clients ? { clients: o.clients } : {}) });

  /**
   * The hopper's own runtime, then each client target that holds a recorded box. One that cannot be listed now — a
   * machine not dialled in — keeps its boxes and their records, past their time limit too, until it can.
   */
  const pass = async (now: Date): Promise<void> => {
    const remote = new Map(o.repo.list().filter((r) => r.machine !== LOCAL).map((r) => [`${r.userId}\0${r.machine}`, { userId: r.userId, machine: r.machine }]));
    const groups = [...(o.runtime ? [{ machine: LOCAL, key: LOCAL, userId: undefined }] : []), ...[...remote].map(([key, g]) => ({ ...g, key }))];
    const next = new Set<string>();
    for (const g of groups) {
      const at = places.runtimeOf(g.userId ?? '', g.machine);
      if (!at) continue;
      try {
        for (const name of await reconcilePass({
          runtime: at.runtime, machine: g.machine, ...(g.userId !== undefined ? { userId: g.userId } : {}), repo: o.repo, instanceId: o.instanceId, now, boxesOf: o.boxesOf,
          waiting: o.waiting(now), launching, newId: randomUUID, joinUrl: at.joinUrl, logger: o.logger,
        }, problems, unclaimed)) next.add(name);
        down.delete(g.key);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        if (down.get(g.key) !== reason) o.logger.warn(`hopper: cannot list the sandbox boxes${g.userId === undefined ? '' : ` on ${g.machine}`}: ${reason}`);
        down.set(g.key, reason);
      }
    }
    unclaimed = next;
    if (o.runtime && now.getTime() - buildsAt >= LEFTOVER_PASS_MS) {
      buildsAt = now.getTime();
      await removeLeftoverBuilds({ runtime: o.runtime, now, inUse: o.repo.list().map((r) => r.image), logger: o.logger })
        .catch((e: unknown) => o.logger.warn(`hopper: cannot remove the leftover box builds: ${e instanceof Error ? e.message : String(e)}`));
    }
  };
  const reconcile = (now?: Date): Promise<void> => (running ??= pass(now ?? o.clock.now()).finally(() => { running = undefined; }));
  // The need boxes' homes no step holds (issue #1371): one whose remove failed, or one a hopper that stopped left.
  const sweepStepHomes = async (): Promise<void> => {
    if (o.runtime) await sweepHomes(o.runtime, { [NEED_LABEL]: o.instanceId }, stepping).catch(() => {});
  };
  // The read-only check (issue #716): beside the hopper, else on a client target of the template's user (issue #708).
  const checkPass = o.checks
    ? createCheckPass({ ...(o.runtime ? { local: o.runtime } : {}), place: places.forCheck, credentials: o.checks, instanceId: o.instanceId, probes: o.probes ?? HOPPER_PROBES, clock: o.clock, logger: o.logger }, o.checks)
    : undefined;
  // The need boxes running now (issue #1007): a sweep burns the hopper's other need boxes, left by a step whose remove
  // failed or by a hopper that stopped mid-step (issue #1349), and notes each burn in the ledger.
  const stepping = new Set<string>();
  /** Removes the need box and its home volume; whether neither is there after. */
  const burn = async (runtime: ContainerRuntime, box: { id: string; name: string }): Promise<boolean> => {
    await runtime.stop(box.id).catch(() => undefined);
    const removed = await runtime.remove(box.id).then(() => true, () => false);
    await runtime.removeVolume(`${box.name}-home`).catch(() => {});
    return removed;
  };
  const sweepSteps = async (): Promise<void> => {
    if (!o.runtime) return;
    const listed = await o.runtime.list({ [NEED_LABEL]: o.instanceId }).catch(() => undefined);
    if (!listed) return;
    const now = o.clock.now().toISOString();
    const open = o.runs.open().filter((r) => r.machine === LOCAL);
    const burned = new Set<string>();
    for (const box of listed) {
      if (stepping.has(box.name)) continue;
      if (await burn(o.runtime, box)) {
        burned.add(box.name);
        o.logger.info(`hopper: sandbox ${box.name} outlived its step: burned`);
      }
    }
    const there = new Set(listed.map((b) => b.name).filter((n) => !burned.has(n)));
    for (const r of open) {
      if (stepping.has(r.box) || there.has(r.box)) continue;
      if (r.endedAt === undefined) o.runs.end(r.id, { at: now, outcome: 'swept', problem: 'the step did not end: its sandbox was burned by the sweep' });
      o.runs.destroyed(r.id, now);
    }
  };
  /** After a step: its need box burned again if it is still there, and its burn noted when the runtime says it is gone. */
  const burnAfter = async (runtime: ContainerRuntime, run: SandboxRun): Promise<void> => {
    const listed = await runtime.list({ [NEED_LABEL]: o.instanceId }).catch(() => undefined);
    if (!listed) return;
    const left = listed.find((b) => b.name === run.box);
    if (left && !(await burn(runtime, left))) {
      o.logger.warn(`hopper: cannot burn the sandbox ${run.box} after its step: the sweep tries again`);
      return;
    }
    o.runs.destroyed(run.id, o.clock.now().toISOString());
  };
  let checking: Promise<void> | undefined;
  const check = (): Promise<void> => (checking ??= Promise.all([sweepSteps().then(sweepStepHomes), checkPass?.() ?? Promise.resolve()]).then(() => undefined)
    .catch((e: unknown) => o.logger.warn(`hopper: the read-only check pass failed: ${e instanceof Error ? e.message : String(e)}`))
    .finally(() => { checking = undefined; }));

  return {
    async view(userId) {
      const problem = o.runtime ? await o.runtime.problem() : noRuntime;
      return {
        launch: { available: problem === undefined, ...(problem !== undefined ? { problem } : {}), ...(o.runtime ? { runtime: o.runtime.kind } : {}) },
        boxes: o.repo.list().filter((r) => r.userId === userId).map(({ userId: _u, ...box }) => box),
        runs: o.runs.latest(userId, RUNS_IN_VIEW).map(({ userId: _u, ...run }) => run),
        problems: [...problems.values()].filter((p) => p.userId === userId).map(({ userId: _u, machine: _m, ...p }) => p),
      };
    },

    async launch(userId, l) {
      const at = await places.place(userId, l.machine);
      const record = await launchBox({
        runtime: at.runtime, repo: o.repo, instanceId: o.instanceId, machine: at.machine, network: at.network, joinUrl: at.joinUrl, now: o.clock.now(),
        id: randomUUID(), mint: (container, template) => o.mint(userId, container, template), launching, startCheckMs: o.startCheckMs ?? START_CHECK_MS,
        ...(o.agentCredentials ? { agentCredential: (ask: AgentCredentialAsk) => o.agentCredentials!(userId, ask) } : {}),
      }, userId, l);
      o.logger.info(`hopper: sandbox box ${record.name} started (${record.image}, ${at.runtime.kind} on ${at.machine}); it joins as a machine`);
      return { container: record.name };
    },

    async needStep(userId, box, io, run) {
      const at = await places.forCheck(userId);
      if (!at) return { exit: 125, problem: `${noRuntime}; and no machine of the user's with a container runtime is dialled in` };
      const ledger: SandboxRun = { id: run.step, userId, jobId: run.jobId, template: run.template, box: box.name, machine: at.machine, startedAt: o.clock.now().toISOString() };
      o.runs.start(ledger);
      stepping.add(box.name);
      let r: NeedBoxResult = { exit: 125, problem: 'the step did not end' };
      try {
        r = await runNeedBox(at.runtime, { ...box, userId, instanceId: o.instanceId, network: at.network }, io);
        o.logger.info(`hopper: need box ${box.name} ended with ${r.exit}${at.runtime === o.runtime ? '' : ` on ${at.machine}`}${r.problem ? `: ${r.problem}` : ''}`);
        return r;
      } finally {
        o.runs.end(ledger.id, { at: o.clock.now().toISOString(), exit: r.exit, outcome: outcomeOf(r), ...(r.problem ? { problem: r.problem } : {}) });
        await burnAfter(at.runtime, ledger);
        stepping.delete(box.name);
      }
    },

    reconcile,
    check,
    start() {
      if (timer) return;
      void reconcile();
      void check();
      timer = setInterval(() => { void reconcile(); void check(); }, RECONCILE_MS);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await Promise.allSettled([running, checking]);
    },
  };
}
