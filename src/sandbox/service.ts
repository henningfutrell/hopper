// The sandbox module (issue #708, design.md "Sandboxes are burned after each step"): the one owner of the life of the
// sandboxes the hopper starts. A job's step runs in a sandbox of its own, a need box (need-box.ts), that the module burns
// after the step and keeps in the sandbox runs ledger (issue #1349): no machine, no lane, no box that stays. The check
// pass's sweep burns any need box that outlives its step, beside the hopper and on each client target dialled in, and
// notes each burn in the ledger. The hopper launches no box
// that joins as a machine: the burn pass (burn-launched.ts, every 10 s and at start) burns each one an older build
// launched, and once an hour removes the leftover box builds beside the hopper (leftover-builds.ts, issue #1120). It
// drives the container runtime beside the hopper, and a client target's own through its client (src/sandbox/runtime.ts).
// A box it cannot remove is a cleanup problem, shown on Machines.
import { hostname } from 'node:os';
import type { SandboxesView } from '../domain/machines.ts';
import { NO_NETWORK, type ContainerRuntime } from '../domain/sandboxes.ts';
import type { SandboxRepository } from '../domain/store.ts';
import type { ProbeCatalog } from '../domain/read-only-check.ts';
import { outcomeOf, type SandboxRun, type SandboxRunRepository } from '../domain/sandbox-runs.ts';
import { createCheckPass, type CheckTemplates } from './check.ts';
import { createWarmPass } from './warm.ts';
import type { Egress } from './egress.ts';
import { removeLeftoverBuilds, LEFTOVER_PASS_MS } from './leftover-builds.ts';
import { HOPPER_PROBES } from './probes.ts';
import { burnLaunched, type Problems } from './burn-launched.ts';
import { createPlacements, LOCAL, NO_RUNTIME, NO_RUNTIME_IN_CLUSTER, type ClientTargets } from './runtime.ts';
import { NO_SECRET_COPY, phaseTimes, runNeedBox, NEED_LABEL, type NeedBox, type NeedBoxIo, type NeedBoxResult } from './need-box.ts';
import { BOX_LABEL, sweepHomes, USER_LABEL } from './owned.ts';
import { trace } from '@opentelemetry/api';
import { liveReader, type LivePoint } from '../telemetry/live.ts';
import { traceJobStep } from '../telemetry/job-steps.ts';
import { traceEnv } from '../telemetry/jobs.ts';

export { BOX_IMAGE } from './box-image.ts';
export { BOX_LABEL, USER_LABEL } from './owned.ts';
export { usersTemplates } from './check.ts';

/** The hopper's own container: in a container, its hostname is its id; a hopper on the host has none. */
export const ownContainer = (localMachine: boolean): string | undefined => (localMachine ? undefined : hostname());

/** The network the release compose.yaml makes and names (issue #711): the same name whatever the project is called. */
export const COMPOSE_NETWORK = 'hopper_default';

/**
 * The hopper's network (issues #708, #711): HOPPER_SANDBOX_NETWORK, else the compose network for a hopper in its
 * container, `host` for one on the host. The sandboxes it starts join it.
 */
export const hopperNetwork = (c: { sandboxNetwork?: string | undefined; localMachine: boolean }): string => c.sandboxNetwork ?? (c.localMachine ? 'host' : COMPOSE_NETWORK);

/** How often the hopper burns the boxes an older build launched, and runs the sweep, the check pass and the warm pass. */
export const PASS_MS = 10_000;
/** A pass a tick finds still in flight this long after it started is logged, once (issue #1965). */
export const PASS_STALL_MS = 5 * 60_000;
/** No box holds a home. */
const NONE: ReadonlySet<string> = new Set();
/** A Kubernetes pod always has the pod network: a box on no network (issue #865) does not run there. */
export const NO_OFFLINE_POD = 'a box on no network does not run on Kubernetes: a pod always joins the pod network';
/** How many of a user's latest sandbox runs the view shows. */
export const RUNS_IN_VIEW = 50;

/** The run a need step's sandbox is (issue #1349): the job and the step it serves, and the template it is made of. */
export interface NeedRun { jobId: string; step: string; template: string }

/** One runtime the sweep burns on: the hopper's own (every user's boxes), or one user's client target (theirs only). */
interface Place { runtime: ContainerRuntime; machine: string; userId?: string; only: Record<string, string> }

export interface SandboxesOptions {
  /** Undefined: no runtime socket is given to the hopper (HOPPER_PODMAN_SOCKET, HOPPER_DOCKER_SOCKET unset). */
  runtime: ContainerRuntime | undefined;
  /** The sandbox records of the boxes an older build launched (issue #708): the burn pass removes each once its box is gone. */
  repo: Pick<SandboxRepository, 'list' | 'remove'>;
  /** The sandbox runs (issue #1349): each sandbox made for one step, from its start to its burn. */
  runs: SandboxRunRepository;
  /** This hopper's instance id: the value of the box label, so two hoppers on one runtime leave each other's boxes. */
  instanceId: string;
  /** The network a box joins (`hopper_default` beside the compose hopper, `host` beside one on the host). */
  network: string;
  /**
   * A read-only box's egress beside the hopper (issue #849): a need box of a read-only template and the check box join its
   * internal network and reach out through its proxy. Absent: they join `network`, with open egress.
   */
  egress?: Egress;
  /** The hopper runs in a Kubernetes pod (issue #1289): with no runtime, that is said, not a socket to give. */
  cluster?: boolean;
  /** A user's client target by name, for a box on it (the remote runtime); absent: boxes start only beside the hopper. */
  clients?: ClientTargets;
  /** The user's sandbox host, first first (issue #2272), read at each sandbox; empty or absent: none set. */
  sandboxHost?: (userId: string) => readonly string[];
  clock: { now(): Date };
  logger: { info(line: string): void; warn(line: string): void };
  /** The templates the read-only check reads, and where it keeps a check (issue #716). Absent: no check runs. */
  checks?: CheckTemplates;
  /** The probes of the read-only check; absent: the hopper's catalog (src/sandbox/probes.ts). */
  probes?: ProbeCatalog;
  /**
   * The steps another live hopper on this database drives now (issue #1954: the keys of the `need-step` sagas whose lease
   * another host holds). The sweep leaves their need boxes, homes and runs to that hopper. Absent: none.
   */
  drivenElsewhere?: () => ReadonlySet<string>;
}

export interface Sandboxes {
  view(userId: string): SandboxesView;
  /**
   * Run one need step (issue #1007, need-box.ts): a one-shot box of the template, its credentials in its
   * environment, beside the hopper, else on a client target of the user's dialled in with a runtime there (as a read-only
   * check runs). The box is burned after the step, and the run kept in the ledger, `run` naming its job and step (issue
   * #1349). Never rejects: no place to run it, or a failure of its own, is `problem`. `offline`: the box joins no network
   * (a container target's command, issue #865).
   */
  needStep(userId: string, box: Omit<NeedBox, 'userId' | 'instanceId' | 'network'> & { offline?: true }, io: Omit<NeedBoxIo, 'phases'>, run: NeedRun): Promise<NeedBoxResult>;
  /**
   * Why no step can run for the user now (issue #865: a container target is offline while it is so); undefined: one can.
   * `offline`: a step whose box joins no network, which a Kubernetes pod cannot be.
   */
  stepProblem(userId: string, o?: { offline?: true }): Promise<string | undefined>;
  /**
   * Issue #2272: "sandbox host <name> is offline" while the user's sandbox host is set and none of its machines is online:
   * a step waits for it, and never starts on another machine. Undefined: none set, or one is online.
   */
  hostOffline(userId: string): Promise<string | undefined>;
  /** One burn pass (burn-launched.ts): each box an older build launched, burned, and its record removed. */
  burnLaunched(): Promise<void>;
  /** The need boxes another live hopper runs now (`drivenElsewhere`), by name: their tokens stay bound too (issue #1954). */
  elsewhere(): ReadonlySet<string>;
  /** One pass of the sweep, the read-only check (issue #716) and the warm pass: each due template is checked; a pass that runs already is joined, each on its own (issue #1965). */
  check(): Promise<void>;
  start(): void;
  /**
   * Ends the timer, then waits for a burn or check pass in flight: the hopper closes its database after this. A pass
   * that waits on a machine's link ends once the hopper closes its links.
   */
  stop(): Promise<void>;
}

export function createSandboxes(o: SandboxesOptions): Sandboxes {
  const problems: Problems = new Map();
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  const down = new Map<string, string>();
  let buildsAt = -Infinity;
  const noRuntime = o.cluster ? NO_RUNTIME_IN_CLUSTER : NO_RUNTIME;
  const noPlace = (): string => `${noRuntime}; and no machine of the user's with a container runtime is dialled in`;
  const places = createPlacements({ local: o.runtime, network: o.network, ...(o.clients ? { clients: o.clients } : {}), ...(o.egress ? { egress: o.egress } : {}), ...(o.sandboxHost ? { hosts: o.sandboxHost } : {}) });

  /**
   * Each client target to look on (issue #1349): every one dialled in now, and each one `also` names. One that cannot
   * be listed now — a machine not dialled in — keeps its boxes, and what records them, until it can.
   */
  const clientPlaces = (also: { userId: string; machine: string }[]): { userId: string; machine: string; key: string }[] =>
    [...new Map([...(o.clients?.allDialledIn() ?? []), ...also].filter((g) => g.machine !== LOCAL).map((g) => [`${g.userId}\0${g.machine}`, g])).entries()]
      .map(([key, g]) => ({ userId: g.userId, machine: g.machine, key }));
  /** The hopper's own runtime, then each client target: one dialled in, or one that holds a recorded box. */
  const pass = async (now: Date): Promise<void> => {
    const groups = [...(o.runtime ? [{ machine: LOCAL, key: LOCAL, userId: undefined }] : []), ...clientPlaces(o.repo.list())];
    for (const g of groups) {
      const runtime = places.runtimeOf(g.userId ?? '', g.machine);
      if (!runtime) continue;
      try {
        await burnLaunched({ runtime, machine: g.machine, ...(g.userId !== undefined ? { userId: g.userId } : {}), repo: o.repo, instanceId: o.instanceId, now, logger: o.logger }, problems);
        down.delete(g.key);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        if (down.get(g.key) !== reason) o.logger.warn(`hopper: cannot list the sandbox boxes${g.userId === undefined ? '' : ` on ${g.machine}`}: ${reason}`);
        down.set(g.key, reason);
      }
    }
    // The leftover box builds (issue #1120), beside the hopper and on each client target it reached now (issue #1202).
    if (now.getTime() - buildsAt >= LEFTOVER_PASS_MS) {
      buildsAt = now.getTime();
      const inUse = o.repo.list().map((r) => r.image);
      for (const g of groups) {
        const runtime = places.runtimeOf(g.userId ?? '', g.machine);
        if (!runtime || down.has(g.key)) continue;
        const where = g.userId === undefined ? 'beside the hopper' : `on ${g.machine}`;
        await removeLeftoverBuilds({ runtime, now, inUse, where, logger: o.logger })
          .catch((e: unknown) => o.logger.warn(`hopper: cannot remove the leftover box builds ${where}: ${e instanceof Error ? e.message : String(e)}`));
      }
    }
  };
  const burnPass = (): Promise<void> => (running ??= pass(o.clock.now()).finally(() => { running = undefined; }));
  // The need boxes' homes no step holds (issue #1371): one whose remove failed, or one a hopper that stopped left.
  const sweepStepHomes = async (at: Place): Promise<void> => {
    await sweepHomes(at.runtime, { [NEED_LABEL]: o.instanceId, ...at.only }, held()).catch(() => {});
    // And the homes of the boxes an older build launched (issue #1349): no box of theirs starts again.
    await sweepHomes(at.runtime, { [BOX_LABEL]: o.instanceId, ...at.only }, NONE).catch(() => {});
  };
  // The read-only check (issue #716): beside the hopper, else on a client target of the template's user (issue #708).
  const checkPass = o.checks
    ? createCheckPass({ ...(o.runtime ? { local: o.runtime } : {}), place: places.forCheck, credentials: o.checks, instanceId: o.instanceId, probes: o.probes ?? HOPPER_PROBES, clock: o.clock, logger: o.logger }, o.checks)
    : undefined;
  // The tools images of approved templates, built ahead of their first step where it runs (issue #1737).
  const warmPass = o.checks ? createWarmPass({ place: places.forCheck, templates: () => o.checks!.templates(), clock: o.clock, logger: o.logger }) : undefined;
  // The need boxes running now (issue #1007): a sweep burns the hopper's other need boxes, left by a step whose remove
  // failed or by a hopper that stopped mid-step (issue #1349), and notes each burn in the ledger.
  const stepping = new Set<string>();
  /** Where each need box of `stepping` runs, for the sandboxes that run now (issue #1486): `local` or `machine`. */
  const steppingAt = new Map<string, 'local' | 'machine'>();
  const needBoxesNow = (): LivePoint[] => (['local', 'machine'] as const).map((place) => ({
    value: [...steppingAt.values()].filter((p) => p === place).length, attributes: { 'hopper.sandbox.kind': 'need', 'hopper.sandbox.place': place, 'hopper.sandbox.state': 'running' },
  }));
  let dropReader: (() => void) | undefined;
  /** Removes the need box and its home volume; whether neither is there after. */
  const burn = async (runtime: ContainerRuntime, box: { id: string; name: string }): Promise<boolean> => {
    await runtime.stop(box.id).catch(() => undefined);
    const removed = await runtime.remove(box.id).then(() => true, () => false);
    await runtime.removeVolume(`${box.name}-home`).catch(() => {});
    return removed;
  };
  /**
   * Beside the hopper, then each client target (issue #1349): one dialled in, or one an open run names. One not dialled
   * in now keeps its boxes, and its runs stay open, until it dials in.
   */
  const sweepPlaces = (): Place[] => [
    ...(o.runtime ? [{ runtime: o.runtime, machine: LOCAL, only: {} }] : []),
    ...clientPlaces(o.runs.open()).flatMap((g) => {
      const runtime = places.runtimeOf(g.userId, g.machine);
      return runtime ? [{ runtime, machine: g.machine, userId: g.userId, only: { [USER_LABEL]: g.userId } }] : [];
    }),
  ];
  /** The need boxes another live hopper runs now: a sweep here leaves them to it, as its own `stepping` (issue #1954). */
  const elsewhere = (): Set<string> => {
    const driven = o.drivenElsewhere?.();
    return new Set(driven?.size ? o.runs.open().filter((r) => driven.has(r.id)).map((r) => r.box) : []);
  };
  /** The need boxes a sweep leaves: this hopper's running now, and those another live hopper runs. */
  const held = (): Set<string> => new Set([...stepping, ...elsewhere()]);
  const sweepSteps = async (at: Place): Promise<void> => {
    const listed = await at.runtime.list({ [NEED_LABEL]: o.instanceId, ...at.only }).catch(() => undefined);
    if (!listed) return;
    const now = o.clock.now().toISOString();
    const open = o.runs.open().filter((r) => r.machine === at.machine && (at.userId === undefined || r.userId === at.userId));
    const burned = new Set<string>(), keep = held();
    for (const box of listed) {
      if (keep.has(box.name)) continue;
      if (await burn(at.runtime, box)) {
        burned.add(box.name);
        o.logger.info(`hopper: sandbox ${box.name} outlived its step: burned${at.machine === LOCAL ? '' : ` on ${at.machine}`}`);
      }
    }
    const there = new Set(listed.map((b) => b.name).filter((n) => !burned.has(n)));
    for (const r of open) {
      if (keep.has(r.box) || there.has(r.box)) continue;
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
  /**
   * Each open run on a client target the user no longer has (issue #1349) is closed: no runtime is there to say its box
   * went. A step that never ended ends as `swept`. A target that is only away keeps its runs open.
   */
  const closeRemoved = (): void => {
    const clients = o.clients;
    if (!clients) return;
    const now = o.clock.now().toISOString();
    for (const r of o.runs.open()) {
      if (r.machine === LOCAL || stepping.has(r.box) || clients.known(r.userId, r.machine)) continue;
      if (r.endedAt === undefined) o.runs.end(r.id, { at: now, outcome: 'swept', problem: 'the step did not end: its machine was removed' });
      o.runs.destroyed(r.id, now, { machineRemoved: true });
      o.logger.info(`hopper: sandbox ${r.box} closed in the ledger: its machine ${r.machine} was removed`);
    }
  };
  /**
   * Startup reconciliation (issue #1371): no step runs yet, so each run not ended was left by a hopper that stopped
   * mid-step. It ends as `interrupted`; the sweep that follows burns its sandbox and notes the burn.
   */
  const endInterrupted = (): void => {
    const now = o.clock.now().toISOString();
    for (const r of o.runs.open()) {
      if (r.endedAt !== undefined || stepping.has(r.box)) continue;
      o.runs.end(r.id, { at: now, outcome: 'interrupted', problem: 'the hopper stopped during the step' });
      o.logger.info(`hopper: sandbox ${r.box} of job ${r.jobId}: the hopper stopped during its step; the run ends as interrupted`);
    }
  };
  /**
   * One pass in flight at a time, each on its own (issue #1965): a warm pass's build of up to 30 min held the check pass
   * with it, and no queued check ran. A tick that finds the pass in flight joins it, and says so once it ran PASS_STALL_MS.
   */
  const inFlight: Promise<void>[] = [];
  const onePass = (what: string, run: () => Promise<void>): (() => Promise<void>) => {
    let now: { done: Promise<void>; since: number; told: boolean } | undefined;
    return () => {
      const at = o.clock.now().getTime();
      if (now) {
        if (!now.told && at - now.since >= PASS_STALL_MS) {
          now.told = true;
          o.logger.warn(`hopper: the ${what} has run for ${Math.floor((at - now.since) / 60_000)} min and has not ended; the next ${what} waits for it`);
        }
        return now.done;
      }
      const pass = { since: at, told: false, done: Promise.resolve() };
      pass.done = run().catch((e: unknown) => o.logger.warn(`hopper: the ${what} failed: ${e instanceof Error ? e.message : String(e)}`))
        .finally(() => { if (now === pass) now = undefined; inFlight.splice(inFlight.indexOf(pass.done), 1); });
      now = pass;
      inFlight.push(pass.done);
      return pass.done;
    };
  };
  const sweep = onePass('sandbox sweep', async () => {
    for (const at of sweepPlaces()) await sweepSteps(at).then(() => sweepStepHomes(at));
    closeRemoved();
  });
  // Issue #2236: each tick a check pass of its own, which starts the due checks that do not run yet; a check that does not
  // end holds its own template only, never the next pass (src/sandbox/check.ts keeps one check of a template at a time).
  const readOnlyChecks = checkPass ? (): Promise<void> => {
    const done: Promise<void> = checkPass().catch((e: unknown) => o.logger.warn(`hopper: the read-only check pass failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => { inFlight.splice(inFlight.indexOf(done), 1); });
    inFlight.push(done);
    return done;
  } : undefined;
  const warm = warmPass ? onePass('warm pass', warmPass) : undefined;
  const check = (): Promise<void> => Promise.all([sweep(), readOnlyChecks?.(), warm?.()]).then(() => undefined);

  const needStep: Sandboxes['needStep'] = async (userId, { offline, ...box }, io, run) => {
    const at = await places.where(userId);
    if (!at) return { exit: 125, problem: noPlace() };
    if ('problem' in at) return { exit: 125, problem: at.problem };
    if (offline && at.runtime.kind === 'kubernetes') return { exit: 125, problem: NO_OFFLINE_POD };
    // A box step's vault secrets (issue #1875) never go to a machine of the user's: it may be the job's own.
    if (box.files?.secrets && Object.keys(box.files.secrets).length > 0 && at.machine !== LOCAL) return { exit: 125, problem: NO_SECRET_COPY };
    const ledger: SandboxRun = { id: run.step, userId, jobId: run.jobId, template: run.template, box: box.name, machine: at.machine, startedAt: o.clock.now().toISOString() };
    o.runs.start(ledger);
    stepping.add(box.name); steppingAt.set(box.name, at.machine === LOCAL ? 'local' : 'machine');
    let r: NeedBoxResult = { exit: 125, problem: 'the step did not end' };
    try {
      // Issue #849: a read-only template's box behind the egress proxy, which holds its hosts before the box starts; and
      // (issue #1875) a box of a template that names egress hosts, which the proxy allows too.
      const egress = (box.template.readOnly || box.template.egress?.length) && !offline ? at.egress : undefined;
      const held = egress ? await egress.allow(box.reaches ?? [], box.template.egress).then(() => undefined, (e: unknown) => (e instanceof Error ? e.message : String(e))) : undefined;
      if (held) {
        r = { exit: 125, problem: held };
        return r;
      }
      const placed = offline ? { network: NO_NETWORK } : egress ? { network: egress.network, env: { ...box.env, ...egress.env } } : { network: at.network };
      let took = '';
      r = await runNeedBox(at.runtime, { ...box, userId, instanceId: o.instanceId, ...placed }, { ...io, phases: (p) => { took = phaseTimes(p); } });
      trace.getActiveSpan()?.setAttribute('hopper.sandbox.place', at.machine === LOCAL ? 'local' : 'machine');
      o.logger.info(`hopper: need box ${box.name} ended with ${r.exit}${at.runtime === o.runtime ? '' : ` on ${at.machine}`}${took}${r.problem ? `: ${r.problem}` : ''}`);
      return r;
    } finally {
      o.runs.end(ledger.id, { at: o.clock.now().toISOString(), exit: r.exit, outcome: outcomeOf(r), ...(r.problem ? { problem: r.problem } : {}) });
      await burnAfter(at.runtime, ledger);
      stepping.delete(box.name); steppingAt.delete(box.name);
    }
  };

  return {
    view(userId) {
      return {
        runs: o.runs.latest(userId, RUNS_IN_VIEW).map(({ userId: _u, ...run }) => run),
        problems: [...problems.values()].filter((p) => p.userId === userId).map(({ userId: _u, machine: _m, ...p }) => p),
      };
    },

    async stepProblem(userId, s) {
      const at = await places.where(userId);
      if (!at) return noPlace();
      if ('problem' in at) return at.problem;
      return s?.offline && at.runtime.kind === 'kubernetes' ? NO_OFFLINE_POD : at.runtime.problem();
    },

    async hostOffline(userId) {
      if (!o.sandboxHost?.(userId).length) return undefined;
      const at = await places.where(userId);
      return at && 'offline' in at ? at.problem : undefined;
    },

    // A need box's run is the job's step `need_box` (issue #1486 part 9): the box runs with the step's trace context.
    needStep: (userId, box, io, run) => traceJobStep(run.jobId, 'need_box', () => needStep(userId, { ...box, env: { ...box.env, ...traceEnv() } }, io, run), outcomeOf),
    burnLaunched: burnPass,
    elsewhere,
    check,
    start() {
      if (timer) return;
      dropReader = liveReader('hopper.sandboxes', needBoxesNow);
      endInterrupted();
      void burnPass();
      void check();
      timer = setInterval(() => { void burnPass(); void check(); }, PASS_MS);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      dropReader?.(); dropReader = undefined;
      await Promise.allSettled([running, ...inFlight]);
    },
  };
}
