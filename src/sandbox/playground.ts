// The sandbox playground (issue #1410, design.md "The sandbox playground"): a person starts many sandboxes at once, lists
// them and destroys them. A playground sandbox is no machine (issue #1371): no join code is minted for it, it takes no
// lane, and Machines does not list it. It runs its image idle (`sleep infinity`), beside the hopper only, on the
// runtime the hopper selected (Podman, Docker or Kubernetes). Its home is a fresh volume (a claim on Kubernetes), made for
// it and removed with it: nothing is reused.
//
// The limits are the hopper's settings (HOPPER_SANDBOX_*, the chart's `sandbox.*` values): how many run at once in all,
// how many per user, and the defaults and maximums of each one's CPUs, memory and time limit. A create takes as many as
// the limits leave room for and refuses the rest, naming the limit; none fits: 429. The room is taken before anything
// is made, so two creates at once never pass a limit.
//
// The sandboxes are kept in memory. Nothing survives the hopper: at start, every container and volume with the
// playground label of this hopper's instance is removed (a restart or a crash left it), and each pass (every 10 s)
// removes a sandbox past its time limit and any labelled resource no sandbox in memory holds.
import { randomUUID } from 'node:crypto';
import type { PlaygroundLimits, PlaygroundSandbox, PlaygroundSize, PlaygroundState, PlaygroundView } from '../domain/sandbox-playground.ts';
import type { ContainerRuntime } from '../domain/sandboxes.ts';
import type { TemplateView } from '../domain/vault.ts';
import { checkWait } from '../domain/read-only-check.ts';
import { BOX_AGENTS, boxImage, BOX_IMAGE } from './box-image.ts';
import { PLAYGROUND_LABEL, staleHome, USER_LABEL } from './owned.ts';

export { PLAYGROUND_LABEL };
/** The label that names a playground sandbox's id on its container and home. */
export const SANDBOX_LABEL = 'io.hopper.sandbox';
export type { PlaygroundLimits, PlaygroundSandbox, PlaygroundSize, PlaygroundState, PlaygroundView };

/** Each limit by the variable that sets it, for the refusal that names it. */
export const LIMIT_SETTINGS = {
  maxConcurrent: 'HOPPER_SANDBOX_MAX_CONCURRENT', maxPerUser: 'HOPPER_SANDBOX_MAX_PER_USER',
  cpus: 'HOPPER_SANDBOX_MAX_CPUS', memoryMb: 'HOPPER_SANDBOX_MAX_MEMORY_MB', ttlMinutes: 'HOPPER_SANDBOX_MAX_TTL_MINUTES',
} as const;

export const PLAYGROUND_LIMITS: PlaygroundLimits = {
  maxConcurrent: 20, maxPerUser: 10,
  defaults: { cpus: 1, memoryMb: 2048, ttlMinutes: 60 },
  max: { cpus: 4, memoryMb: 8192, ttlMinutes: 1440 },
};

/** Why these limits cannot be used: a default above its max. Undefined: they can. */
export function playgroundLimitsProblem(l: PlaygroundLimits): string | undefined {
  for (const k of ['cpus', 'memoryMb', 'ttlMinutes'] as const) {
    if (l.defaults[k] > l.max[k]) return `the default ${k} ${l.defaults[k]} is more than the max ${l.max[k]} (${LIMIT_SETTINGS[k]})`;
  }
  return undefined;
}

/** What a create asks for: how many, of an agent's box image or of a template, and their size. */
export interface PlaygroundAsk { count: number; agent: string; template?: TemplateView; size: Partial<PlaygroundSize> }

/** The limit a create met: its name and the variable that sets it. */
export interface MetLimit { limit: 'maxConcurrent' | 'maxPerUser'; setting: string; reason: string }

export interface PlaygroundCreated { started: PlaygroundSandbox[]; refused?: MetLimit & { count: number } }

/** A create the playground refuses before it makes anything. `limit`: the limit it met, for a 429. */
export class PlaygroundRefused extends Error {
  readonly status: 400 | 409 | 429;
  readonly limit: MetLimit | undefined;
  constructor(status: 400 | 409 | 429, message: string, limit?: MetLimit) {
    super(message);
    this.status = status;
    this.limit = limit;
  }
}

export interface Playground {
  view(userId: string): Promise<PlaygroundView>;
  /** Starts as many as the limits leave room for; the starts go on after it answers. Throws PlaygroundRefused. */
  create(userId: string, ask: PlaygroundAsk): PlaygroundCreated;
  /** Destroys the user's sandboxes these ids name, or all of them; answers how many went. */
  destroy(userId: string, ids: string[] | 'all'): Promise<{ destroyed: number; problems: { id: string; problem: string }[] }>;
  /** One pass at `now`: the time limits, and the labelled resources no sandbox holds. */
  sweep(now?: Date): Promise<void>;
  /** Removes every leftover of this instance, then sweeps every PLAYGROUND_PASS_MS. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** How often the playground sweeps. */
export const PLAYGROUND_PASS_MS = 10_000;
/** What a playground sandbox runs: nothing, until it is destroyed. */
export const IDLE_SCRIPT = 'exec sleep infinity';

/** `homeMade`: the start made its home; a home that was there already is someone else's, and stays. */
interface Entry extends PlaygroundSandbox { userId: string; containerId?: string; volume: string; homeMade?: boolean; starting?: Promise<void> }

const counts = (s: PlaygroundState): boolean => s !== 'failed';

export function createPlayground(o: {
  /** Undefined: the hopper is given no runtime: no sandbox starts. */
  runtime: ContainerRuntime | undefined;
  /** Why no sandbox starts without a runtime. */
  noRuntime: string;
  instanceId: string;
  network: string;
  limits: PlaygroundLimits;
  clock: { now(): Date };
  logger: { info(line: string): void; warn(line: string): void };
  newId?: () => string;
}): Playground {
  const entries = new Map<string, Entry>();
  const newId = o.newId ?? randomUUID;
  const label = { [PLAYGROUND_LABEL]: o.instanceId };
  let timer: ReturnType<typeof setInterval> | undefined;
  let sweeping: Promise<void> | undefined;
  const say = (e: unknown): string => (e instanceof Error ? e.message : String(e));
  const shown = ({ userId: _u, containerId: _c, volume: _v, homeMade: _h, starting: _s, ...e }: Entry): PlaygroundSandbox => structuredClone(e);

  /**
   * Removes what the sandbox's start made: its container — by its id, else the one its sandbox label names (a create whose
   * answer was lost) — and its home. Throws when one of them stays.
   */
  const teardown = async (rt: ContainerRuntime, e: Entry): Promise<void> => {
    const id = e.containerId ?? (await rt.list({ ...label, [SANDBOX_LABEL]: e.id }))[0]?.id;
    if (id !== undefined) await rt.remove(id);
    if (e.homeMade) await rt.removeVolume(e.volume);
  };

  /** Destroys one: its start, when it runs, removes what it made; else it is removed now. */
  const destroyOne = async (e: Entry): Promise<string | undefined> => {
    const was = e.state;
    e.state = 'destroying';
    if (e.starting) {
      await e.starting;
      return entries.has(e.id) ? e.problem : undefined;
    }
    if (was === 'failed' || !o.runtime) {
      entries.delete(e.id);
      return undefined;
    }
    try {
      await teardown(o.runtime, e);
      entries.delete(e.id);
      return undefined;
    } catch (err) {
      e.problem = `cannot remove it yet: ${say(err)}`;
      return e.problem;
    }
  };

  const launch = async (rt: ContainerRuntime, e: Entry, template: TemplateView | undefined): Promise<void> => {
    let failure: string | undefined;
    try {
      const { image, user } = await boxImage(rt, template?.image ?? `${BOX_IMAGE}:box-${e.agent}`, template?.tools, template?.readOnly);
      e.image = image;
      if (e.state === 'starting') {
        const labels = { ...label, [USER_LABEL]: e.userId, [SANDBOX_LABEL]: e.id };
        e.homeMade = await rt.createVolume(e.volume, labels);
        if (!e.homeMade) throw staleHome(e.volume);
        e.containerId = await rt.create({
          name: e.name, image, network: o.network, volume: e.volume, labels, user, env: {}, script: IDLE_SCRIPT,
          limits: { cpus: e.size.cpus, memoryMb: e.size.memoryMb },
        });
        await rt.start(e.containerId);
      }
    } catch (err) {
      failure = say(err);
    }
    if (failure === undefined && e.state === 'starting') {
      e.state = 'running';
      return;
    }
    // Failed, or destroyed while it started: nothing of it is left.
    try {
      await teardown(rt, e);
    } catch (err) {
      e.state = 'destroying';
      e.problem = `cannot remove it yet: ${say(err)}`;
      o.logger.warn(`hopper: playground sandbox ${e.name}: ${e.problem}`);
      return;
    }
    if (e.state === 'destroying') {
      entries.delete(e.id);
      return;
    }
    e.state = 'failed';
    e.problem = failure;
    o.logger.warn(`hopper: playground sandbox ${e.name} did not start: ${failure}`);
  };

  const pass = async (now: Date): Promise<void> => {
    if (!o.runtime) return;
    for (const e of [...entries.values()]) {
      if (e.starting) continue;
      const expired = e.state === 'running' && Date.parse(e.expiresAt) <= now.getTime();
      if (!expired && e.state !== 'destroying') continue;
      if ((await destroyOne(e)) === undefined) o.logger.info(`hopper: playground sandbox ${e.name} removed${expired ? ': its time limit passed' : ''}`);
    }
    // What no sandbox holds: a hopper that stopped or crashed left it, or a start whose answer was lost made it.
    const held = new Set([...entries.values()].map((e) => e.name));
    const ids = new Set([...entries.values()].map((e) => e.id));
    for (const c of await o.runtime.list(label)) {
      if (held.has(c.name) || ids.has(c.labels[SANDBOX_LABEL] ?? '')) continue;
      await o.runtime.remove(c.id).then(() => o.logger.info(`hopper: playground leftover ${c.name} removed`), (err: unknown) => o.logger.warn(`hopper: cannot remove the playground leftover ${c.name}: ${say(err)}`));
    }
    const homes = new Set([...entries.values()].map((e) => e.volume));
    for (const v of await o.runtime.listVolumes(label)) {
      if (homes.has(v)) continue;
      await o.runtime.removeVolume(v).catch((err: unknown) => o.logger.warn(`hopper: cannot remove the playground leftover volume ${v}: ${say(err)}`));
    }
  };
  const sweep = (now?: Date): Promise<void> => (sweeping ??= pass(now ?? o.clock.now())
    .catch((err: unknown) => o.logger.warn(`hopper: the playground pass failed: ${say(err)}`))
    .finally(() => { sweeping = undefined; }));

  /**
   * The size asked for, the template's and the hopper's defaults filling the rest, each within both maximums. A template
   * has no time limit (issue #1349): the hopper's alone holds it.
   */
  const sizeOf = (ask: PlaygroundAsk): PlaygroundSize => {
    const tl = ask.template?.limits;
    const pick = (k: keyof PlaygroundSize): number => {
      const t = k === 'ttlMinutes' ? undefined : tl?.[k];
      const v = ask.size[k] ?? t?.default ?? o.limits.defaults[k];
      if (!(v > 0)) throw new PlaygroundRefused(400, `${k} must be more than 0`);
      if (v > o.limits.max[k]) throw new PlaygroundRefused(400, `${k} ${v} is more than the hopper allows a playground sandbox (${LIMIT_SETTINGS[k]}): at most ${o.limits.max[k]}`);
      const tmax = t?.max;
      if (tmax !== undefined && v > tmax) throw new PlaygroundRefused(400, `${k} ${v} is more than the template ${ask.template!.name} allows: at most ${tmax}`);
      return v;
    };
    return { cpus: pick('cpus'), memoryMb: pick('memoryMb'), ttlMinutes: pick('ttlMinutes') };
  };

  return {
    async view(userId) {
      const problem = o.runtime ? await o.runtime.problem() : o.noRuntime;
      const live = [...entries.values()].filter((e) => counts(e.state));
      return {
        ...(problem !== undefined ? { problem } : {}),
        agents: [...BOX_AGENTS],
        limits: structuredClone(o.limits),
        running: { all: live.length, yours: live.filter((e) => e.userId === userId).length },
        sandboxes: [...entries.values()].filter((e) => e.userId === userId).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name)).map(shown),
      };
    },

    create(userId, ask) {
      const rt = o.runtime;
      if (!rt) throw new PlaygroundRefused(409, o.noRuntime);
      const t = ask.template;
      if (t && (t.approval === undefined || t.pending.image)) throw new PlaygroundRefused(409, `the image of template ${t.name} is not approved: approve it on Access requests first`);
      const waits = t && checkWait(t);
      if (waits) throw new PlaygroundRefused(409, waits);
      const size = sizeOf(ask);
      if (!(ask.count >= 1)) throw new PlaygroundRefused(400, 'count must be 1 or more');

      // The room, taken now: nothing awaits between the count and the entries.
      const live = [...entries.values()].filter((e) => counts(e.state));
      const all = o.limits.maxConcurrent - live.length;
      const yours = o.limits.maxPerUser - live.filter((e) => e.userId === userId).length;
      const room = Math.max(0, Math.min(all, yours));
      const met = (): MetLimit => (all <= yours
        ? { limit: 'maxConcurrent', setting: LIMIT_SETTINGS.maxConcurrent, reason: `at most ${o.limits.maxConcurrent} playground sandboxes run at once (${LIMIT_SETTINGS.maxConcurrent}); ${live.length} run now` }
        : { limit: 'maxPerUser', setting: LIMIT_SETTINGS.maxPerUser, reason: `at most ${o.limits.maxPerUser} playground sandboxes of one user run at once (${LIMIT_SETTINGS.maxPerUser}); ${o.limits.maxPerUser - yours} of yours run now` });
      if (room === 0) {
        const limit = met();
        throw new PlaygroundRefused(429, `no playground sandbox started: ${limit.reason}`, limit);
      }

      const now = o.clock.now();
      const started: Entry[] = [];
      for (let i = 0; i < Math.min(ask.count, room); i++) {
        const id = newId();
        const name = `hopper-playground-${id.replaceAll('-', '').slice(0, 12)}`;
        const e: Entry = {
          id, userId, name, agent: ask.agent, ...(t ? { template: t.name } : {}), size, state: 'starting', volume: `${name}-home`,
          createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + size.ttlMinutes * 60_000).toISOString(),
        };
        entries.set(id, e);
        started.push(e);
      }
      for (const e of started) {
        e.starting = launch(rt, e, t).finally(() => { delete e.starting; });
      }
      o.logger.info(`hopper: ${started.length} playground sandbox${started.length === 1 ? '' : 'es'} starting (${rt.kind})`);
      const refused = ask.count - started.length;
      return { started: started.map(shown), ...(refused > 0 ? { refused: { ...met(), count: refused } } : {}) };
    },

    async destroy(userId, ids) {
      const mine = [...entries.values()].filter((e) => e.userId === userId && (ids === 'all' || ids.includes(e.id)));
      const left = await Promise.all(mine.map(async (e) => ({ id: e.id, problem: await destroyOne(e) })));
      const problems = left.filter((l): l is { id: string; problem: string } => l.problem !== undefined);
      if (mine.length) o.logger.info(`hopper: ${mine.length - problems.length} playground sandbox${mine.length - problems.length === 1 ? '' : 'es'} destroyed`);
      return { destroyed: mine.length - problems.length, problems };
    },

    sweep,

    async start() {
      if (timer) return;
      // Nothing survives a hopper: every sandbox of this instance a restart or a crash left goes now.
      await sweep();
      timer = setInterval(() => { void sweep(); }, PLAYGROUND_PASS_MS);
      timer.unref();
    },

    // A start in flight is not waited for (a pod may take minutes): the next start removes what it made.
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await sweeping;
    },
  };
}
