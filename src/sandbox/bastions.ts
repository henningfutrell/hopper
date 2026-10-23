// A user's bastions (issue #2146, design.md "Bastions"): the one sandbox that outlives a step. A job whose sandbox runs of
// a template are approved starts one bastion of it: the vault mints each observe its targets need for the bastion's box
// (bastion.ts), the box starts through the sandbox module as a need box (its ledger row, its burn, the sweep leaves it
// while it runs), and the hopper mints the tokens again every few minutes and copies them in. It ends when its TTL
// passes with no use (an hour; each relay connection renews it, and it never ends while one is open), when its job ends, when the job stops it, when a
// renewal is refused, or when its box ends by itself; then its tokens are released. One bastion a job at a time. Kept
// in memory: a hopper that stops ends every bastion, and its start's sweep burns the boxes. The relay (part 2): a job's
// connection to one of its bastion's targets is a byte pipe to a command the hopper starts in the box for it, which
// connects to that target's forward on 127.0.0.1 there (relayCommand); the connection ends with the bastion. Part 3: a
// bastion starts only to targets approved with its template, Access decides each connection, and each connection, or
// its refusal, is an event on the job's timeline. Part 6: a bastion holds the vault secrets the job names, each a header
// file in its box, and a bastion read runs one HTTP read of a target there with one of them (bastion-read.ts).
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { OperationProfile } from '../domain/access.ts';
import type { Minted, MintReach } from '../domain/minting.ts';
import type { Job, NewEvent } from '../domain/types.ts';
import type { TemplateView } from '../domain/vault.ts';
import type { BoxPipe } from '../domain/sandboxes.ts';
import type { BastionEnd, BastionView } from '../domain/bastions.ts';
import type { StepSecretAsk } from '../vault/step-delivery.ts';
import { readAnswer, readCommand, readHeader, readSecretName, READ_MAX_BYTES, type BastionRead } from './bastion-read.ts';
import type { NeedBox, NeedBoxIo, NeedBoxResult, RunningNeedBox } from './need-box.ts';
import {
  bastionEnv, bastionTokens, forwardWatch, placeTargets, relayCommand, targetsOutside, targetText, BASTION_MAX_MS, BASTION_RENEW_MS, BASTION_TTL_MS, type BastionCredential, type BastionTarget, type PlacedTarget,
} from './bastion.ts';

export type { BastionEnd, BastionView } from '../domain/bastions.ts';

/** How often the hopper looks whether a bastion's job is still at work and its TTL has passed. */
const CHECK_MS = 5_000;
/** The most of a bastion's output the hopper keeps: its tail. */
const LOG_TAIL = 4096;
/** How long a relay connection that got no answer waits for kubectl to say why. */
const SAID_MS = 1_000;
/** How long a relay connection waits for a forward that has said nothing yet to listen (issue #2484). */
const LISTEN_MS = 10_000;

export interface BastionsOptions {
  userId: string;
  /** The vault's mint for one observe of the bastion's box (src/vault/need-mint.ts, as a need box's). */
  mint(ask: { template: string; step: string; job: string; profile: OperationProfile }): Promise<{ minted: Minted; reach: MintReach } | { refused: string }>;
  /** The bastion's box ended: each token minted for it stops working (the vault's `releaseMints`). Never rejects. */
  release(box: string): Promise<void>;
  /** A vault secret for the bastion's box (part 6), after the job's vault grant: the vault's `forStep`, as a box step's. */
  secret?: (ask: StepSecretAsk) => Promise<{ value: string } | { refused: string }>;
  /** Runs the bastion's box (the sandbox module's `needStep`); absent: this hopper runs no sandbox. */
  run?: (box: Omit<NeedBox, 'userId' | 'instanceId' | 'network'>, io: Omit<NeedBoxIo, 'phases'>, run: { jobId: string; step: string; template: string }) => Promise<NeedBoxResult>;
  /**
   * Whether the job may relay to the target of its bastion of `template` now (part 3): Access's `bastion#can_relay`, with
   * whether a person approved the target with the template as it is now. Asked at each connection.
   */
  mayRelay(ask: { jobId: string; template: string; target: string }): Promise<{ allowed: boolean; reason: string }>;
  /** Whether the job is at work: a bastion of a job that stopped ends. */
  atWork(jobId: string): boolean;
  /** Where each bastion's own directory goes on this machine: the hopper's work dir (scratch). */
  dir: string;
  record(event: NewEvent): void;
  log(line: string): void;
  newId?: () => string;
  now?: () => Date;
  ttlMs?: number;
  renewMs?: number;
  checkMs?: number;
  /** How long a relay connection that got no answer waits for kubectl's line on it (issue #2474). */
  saidMs?: number;
  /** How long a relay connection waits for a starting bastion, or a forward that has said nothing yet (issue #2484). */
  listenMs?: number;
}

export interface Bastions {
  /**
   * Starts the job's bastion of `template` to `targets` (the template ready, its runs approved for the job: the caller
   * checks), or answers the one it has with the same template, targets and secrets; a no with its HTTP status. `secrets`
   * (part 6): vault secrets the template gives, each a header file in the box for bastion reads.
   */
  start(job: Job, template: TemplateView, targets: readonly BastionTarget[], secrets?: readonly string[]): Promise<BastionView | { status: number; no: string }>;
  /** The job's bastion: the one that runs, else the last one that ended. */
  of(jobId: string): BastionView | undefined;
  /** Each bastion that starts or runs now, oldest first: what a person sees, to stop one. */
  list(): BastionView[];
  /** Stops the job's bastion that runs, `by` the job or a person; undefined: it has none. */
  stop(jobId: string, by: string): BastionView | undefined;
  /** A use of the job's bastion: its TTL starts again. */
  touch(jobId: string): void;
  /**
   * A connection to `target` of the job's bastion that runs (the relay, part 2): a byte pipe to 127.0.0.1 at its port in
   * the box. Its TTL starts again, and it does not expire while a connection is open. A no with its HTTP status.
   * `command`: the command started for it, from the target's port (a bastion read's); else the connect command.
   */
  relay(jobId: string, target: string, command?: (local: number) => string[]): Promise<BoxPipe | { status: number; no: string }>;
  /**
   * Why a relay connection got no byte back (issue #2474): its target's name, and what kubectl said of that
   * forward after the connection opened, else the connect command's stderr. It waits a short time for kubectl's line.
   */
  noAnswer(target: string, pipe: BoxPipe): Promise<string>;
  /** One HTTP read of a target of the job's bastion that runs, in its box (part 6): the status and body, or a no. */
  read(jobId: string, r: BastionRead): Promise<{ status: number; body: Buffer } | { status: number; no: string }>;
  /** Stops every bastion and waits for their boxes to go: the hopper stops. */
  stopAll(): Promise<void>;
}

interface Live {
  view: BastionView;
  placed: PlacedTarget[];
  observes: OperationProfile[];
  stop: AbortController;
  /** How to start a command in its box, once it runs: none before, or when its runtime starts none. */
  pipe?: (cmd: readonly string[]) => Promise<BoxPipe>;
  /** Its relay connections open now. */
  open: Set<BoxPipe>;
  why?: { end: BastionEnd; by?: string; problem?: string };
  timers: ReturnType<typeof setInterval>[];
  done: Promise<void>;
  watch: ReturnType<typeof forwardWatch>;
}

const sameTargets = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join(' ') === [...b].sort().join(' ');
const profileText = (p: OperationProfile): string => `${p.operation} on ${p.asset.kind} ${p.asset.name}`;

export function createBastions(o: BastionsOptions): Bastions {
  const newId = o.newId ?? (() => randomUUID());
  const now = o.now ?? (() => new Date());
  const ttlMs = o.ttlMs ?? BASTION_TTL_MS;
  const live = new Map<string, Live>();
  const last = new Map<string, BastionView>();
  /** Bastions that ended whose box still goes: the hopper's stop waits for them. */
  const going = new Set<Live>();
  /** Each relay connection's count of kubectl's lines on its forward when it opened (issue #2474). */
  const saidAt = new WeakMap<BoxPipe, { live: Live; n: number }>();

  /** Each observe minted for the box, or why one was not. */
  const mintAll = async (b: { template: string; box: string; jobId: string }, observes: readonly OperationProfile[]): Promise<BastionCredential[] | string> => {
    const out: BastionCredential[] = [];
    for (const profile of observes) {
      const r = await o.mint({ template: b.template, step: b.box, job: b.jobId, profile });
      if ('refused' in r) return `the vault minted no ${profileText(profile)}: ${r.refused}`;
      if (r.minted.kind !== 'kube' || r.reach.kind !== 'kube') return `the vault minted no Kubernetes token for ${profileText(profile)}`;
      out.push({ profile, minted: r.minted, reach: r.reach });
    }
    return out;
  };

  /**
   * Ends the bastion, once: the first reason is the one kept. Issue #2474: it is ended for the job at once — it leaves
   * the job's running bastion, its timers stop and its relay connections close —, so the job may start a new one while
   * its box still goes. Its tokens are released, and its end recorded, once its box is gone (ended).
   */
  const end = (l: Live, why: NonNullable<Live['why']>): void => {
    if (l.why) return;
    l.why = why;
    for (const t of l.timers) clearInterval(t);
    for (const p of l.open) p.destroy();
    if (live.get(l.view.jobId) === l) live.delete(l.view.jobId);
    going.add(l);
    last.set(l.view.jobId, {
      ...l.view, targets: l.view.targets.map((t) => ({ ...t })), state: 'ended', endedAt: now().toISOString(), ended: why.end,
      ...(why.by ? { endedBy: why.by } : {}), ...(why.problem ? { problem: why.problem } : {}),
    });
    l.stop.abort();
  };

  /** Keeps its end once its box is gone: its tokens released, the end an event on the job's timeline. */
  const ended = async (l: Live, r: NeedBoxResult): Promise<void> => {
    end(l, { end: 'failed', problem: r.problem ?? `its box ended with ${r.exit}` });
    const why = l.why!;
    rmSync(join(o.dir, l.view.id), { recursive: true, force: true });
    await o.release(l.view.box).catch(() => undefined);
    going.delete(l);
    const view = { ...l.view, ...(why.problem ? { problem: why.problem } : {}) };
    o.record({
      type: 'bastion.ended', jobId: view.jobId,
      data: { bastion: view.id, template: view.template, box: view.box, reason: why.end, ...(why.by ? { by: why.by } : {}), ...(why.problem ? { problem: why.problem } : {}) },
    });
    o.log(`hopper: bastion ${view.box} of job ${view.jobId} ended: ${why.end}${why.problem ? `: ${why.problem}` : ''}`);
  };

  /** A use: its TTL starts again. */
  const used = (l: Live | undefined): void => { if (l && !l.why) l.view.expiresAt = new Date(now().getTime() + ttlMs).toISOString(); };

  const viewOf = (jobId: string): BastionView | undefined => {
    const l = live.get(jobId);
    return l ? { ...l.view, targets: l.view.targets.map((t) => ({ ...t })) } : last.get(jobId);
  };

  return {
    async start(job, template, targets, secrets) {
      const names = [...new Set(secrets ?? [])].sort();
      const ungiven = names.filter((n) => !template.gives.includes(n));
      if (ungiven.length) return { status: 403, no: `template ${template.name} does not give ${ungiven.join(', ')} now: ask for a template with --secrets "${ungiven.join(' ')}", which a person approves` };
      const placing = placeTargets(targets, template.profiles);
      if (typeof placing === 'string') return { status: 400, no: placing };
      const outside = targetsOutside(template, targets);
      if (outside) return { status: 403, no: outside.why === 'unnamed' ? `${outside.no}: ask for a template with --targets "${outside.targets.join(' ')}"` : outside.no };
      const asked = placing.placed.map(targetText);
      const running = live.get(job.id);
      if (running) {
        if (running.view.template === template.name && sameTargets(running.view.targets.map((t) => t.target), asked) && sameTargets(running.view.secrets ?? [], names)) return viewOf(job.id)!;
        return { status: 409, no: `this job's bastion ${running.view.id} runs: stop it first (sh "$HOPPER_SKILL" bastion stop), then ask for the new one` };
      }
      const run = o.run;
      if (!run) return { status: 503, no: 'this hopper runs no sandbox: it is given no container runtime (docs/deploy.md "Sandboxes the hopper starts")' };
      const id = newId();
      const box = `hopper-bastion-${template.name}-${id.slice(0, 8)}`;
      const credentials = await mintAll({ template: template.name, box, jobId: job.id }, placing.observes);
      const held = typeof credentials === 'string' ? credentials : await secretsFor({ template: template.name, box, jobId: job.id }, names);
      if (typeof credentials === 'string' || typeof held === 'string') {
        await o.release(box).catch(() => undefined);
        return { status: 403, no: typeof credentials === 'string' ? credentials : String(held) };
      }
      // A second ask while the first one minted: the first one is the bastion.
      if (live.has(job.id)) {
        await o.release(box).catch(() => undefined);
        return viewOf(job.id)!;
      }
      const at = now();
      const l: Live = {
        view: {
          id, jobId: job.id, template: template.name, box, targets: placing.placed.map((t) => ({ target: targetText(t) })), ...(names.length ? { secrets: names } : {}), state: 'starting',
          startedAt: at.toISOString(), expiresAt: new Date(at.getTime() + ttlMs).toISOString(), log: '',
        },
        placed: placing.placed, observes: placing.observes, stop: new AbortController(), open: new Set(), timers: [], done: Promise.resolve(),
        // Issue #2413: whether each forward listens, from its lines in the box's output, so a job sees a forward that fails.
        watch: forwardWatch(),
      };
      live.set(job.id, l);
      o.record({ type: 'bastion.started', jobId: job.id, data: { bastion: id, template: template.name, box, targets: asked, ...(names.length ? { secrets: names } : {}), expiresAt: l.view.expiresAt } });
      const renewing = ({ renew, pipe }: RunningNeedBox): void => {
        l.view.state = 'running';
        if (pipe) l.pipe = pipe;
        l.timers.push(setInterval(() => {
          void mintAll({ template: template.name, box, jobId: job.id }, l.observes).then(async (next) => {
            if (l.why) return;
            if (typeof next === 'string') { end(l, { end: 'failed', problem: next }); return; }
            await renew(bastionTokens(next)).catch((e: unknown) => end(l, { end: 'failed', problem: `the renewed tokens did not go into its box: ${e instanceof Error ? e.message : String(e)}` }));
          });
        }, o.renewMs ?? BASTION_RENEW_MS));
      };
      l.timers.push(setInterval(() => {
        if (!o.atWork(job.id)) end(l, { end: 'job-ended' });
        else if (l.open.size === 0 && now().getTime() >= Date.parse(l.view.expiresAt)) end(l, { end: 'expired' });
      }, o.checkMs ?? CHECK_MS));
      const t = template;
      const watch = l.watch;
      mkdirSync(join(o.dir, id), { recursive: true, mode: 0o700 });
      l.done = run({
        name: box, template: { image: t.image, ...(t.tools ? { tools: t.tools } : {}), ...(t.egress?.length ? { egress: t.egress } : {}), ...(t.readOnly ? { readOnly: true as const } : {}), ...(t.limits ? { limits: t.limits } : {}) },
        // Part 5: a read-only template's box runs behind the egress proxy, which lets its tokens' cluster through.
        env: bastionEnv(l.placed, credentials), reaches: credentials.map((c) => c.reach), timeoutMs: BASTION_MAX_MS, dir: join(o.dir, id), files: { secrets: { ...bastionTokens(credentials), ...held } },
      }, {
        log: (chunk) => {
          l.view.log = (l.view.log + chunk).slice(-LOG_TAIL);
          watch.add(chunk);
          l.view.targets = l.view.targets.map((x) => ({ target: x.target, ...watch.of(x.target) }));
        },
        signal: l.stop.signal, running: renewing,
      }, { jobId: job.id, step: id, template: template.name }).then((r) => ended(l, r), (e: unknown) => ended(l, { exit: 125, problem: e instanceof Error ? e.message : String(e) }));
      return viewOf(job.id)!;
    },

    of: viewOf,

    list: () => [...live.keys()].map((jobId) => viewOf(jobId)!),

    stop(jobId, by) {
      const l = live.get(jobId);
      if (!l) return undefined;
      end(l, { end: 'stopped', by });
      return viewOf(jobId);
    },

    touch: (jobId) => used(live.get(jobId)),

    relay,
    read,

    async noAnswer(target, pipe) {
      const at = saidAt.get(pipe);
      const said = (): string | undefined => {
        const p = at?.live.watch.problem(target);
        return p && p.n > at!.n ? p.said : undefined;
      };
      const saidMs = o.saidMs ?? SAID_MS;
      for (let waited = 0; !said() && at && !at.live.why && waited < saidMs; waited += 50) await new Promise((r) => setTimeout(r, 50));
      const words = said();
      const stderr = pipe.stderr().trim();
      const head = `the bastion's forward to ${target} closed the connection with no answer`;
      if (words) return `${head}: kubectl said: ${words}`;
      if (stderr) return `${head}: ${stderr}`;
      return `${head}${at?.live.why ? `: the bastion ${at.live.view.id} ended` : ''}. See its output with sh "$HOPPER_SKILL" bastion`;
    },

    async stopAll() {
      const all = [...live.values()];
      for (const l of all) end(l, { end: 'stopped', by: 'the hopper' });
      await Promise.allSettled([...going].map((l) => l.done));
    },
  };

  /** Each vault secret named, as its header file for reads, or why one was not given. */
  async function secretsFor(b: { template: string; box: string; jobId: string }, names: readonly string[]): Promise<Record<string, string> | string> {
    const out: Record<string, string> = {};
    for (const name of names) {
      const r = o.secret ? await o.secret({ name, job: b.jobId, host: b.box, template: b.template }) : { refused: 'the hopper gives no vault secret to a bastion here' };
      if ('refused' in r) return `the vault gave no ${name}: ${r.refused}`;
      out[readSecretName(name)] = readHeader(r.value);
    }
    return out;
  }

  async function relay(jobId: string, target: string, command?: (local: number) => string[]): Promise<BoxPipe | { status: number; no: string }> {
    const l = live.get(jobId);
    if (!l || l.why) return { status: 404, no: 'this job has no bastion that runs: ask for one with sh "$HOPPER_SKILL" bastion --template NAME --targets "..." --why "..."' };
    const t = l.placed.find((x) => targetText(x) === target);
    if (!t) return { status: 404, no: `the job's bastion forwards to ${l.view.targets.map((x) => x.target).join(', ')}; not to ${target}` };
    // Issue #2484: a read right after the start found no forward that listened, and curl said only "Failed to connect".
    // A connection waits a short time for the bastion to run and its forward to say whether it listens.
    const listenMs = o.listenMs ?? LISTEN_MS;
    const said = (): boolean => l.view.state === 'running' && l.view.targets.find((x) => x.target === target)?.listening !== undefined;
    for (let waited = 0; !said() && !l.why && waited < listenMs; waited += 50) await new Promise((r) => setTimeout(r, 50));
    if (l.why) return { status: 404, no: `the job's bastion ${l.view.id} ended` };
    if (l.view.state !== 'running') return { status: 409, no: `the job's bastion ${l.view.id} is ${l.view.state}: ask again in a few seconds` };
    if (!l.pipe) return { status: 503, no: 'the container runtime of the bastion\'s box starts no command in it: no relay reaches it' };
    // Issue #2413: a forward that ended does not listen; kubectl's own words say why, not the connect command's refusal.
    const forward = l.view.targets.find((x) => x.target === target);
    if (forward?.listening === false) {
      return { status: 503, no: `the bastion's forward to ${target} does not listen in the box: ${forward.said}. Its loop starts it again every 2 s; see where it stands with sh "$HOPPER_SKILL" bastion` };
    }
    if (forward?.listening === undefined) {
      return { status: 503, no: `the bastion's forward to ${target} does not listen in the box yet: kubectl said nothing of it in ${listenMs / 1000} s. See where it stands with sh "$HOPPER_SKILL" bastion` };
    }
    // Issue #2566: the port is the one kubectl picked and said, never one the hopper guessed.
    if (forward.local === undefined) return { status: 503, no: `the bastion's forward to ${target} did not say its port in the box: see its output with sh "$HOPPER_SKILL" bastion` };
    const access = await o.mayRelay({ jobId, template: l.view.template, target }).catch((e: unknown) => ({ allowed: false, reason: `Access could not be asked: ${e instanceof Error ? e.message : String(e)}` }));
    if (!access.allowed) {
      o.record({ type: 'bastion.relay_refused', jobId, data: { bastion: l.view.id, target, reason: access.reason } });
      return { status: 403, no: `Access denies the relay to ${target}: ${access.reason}` };
    }
    let pipe: BoxPipe;
    try {
      pipe = await l.pipe(command ? command(forward.local) : relayCommand(forward.local));
    } catch (e) {
      return { status: 502, no: `the relay did not reach ${target} in the box: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (l.why) { pipe.destroy(); return { status: 404, no: `the job's bastion ${l.view.id} ended` }; }
    l.open.add(pipe);
    saidAt.set(pipe, { live: l, n: l.watch.problem(target)?.n ?? 0 });
    used(l);
    const opened = now();
    pipe.once('close', () => {
      l.open.delete(pipe);
      used(l);
      o.record({ type: 'bastion.relayed', jobId, data: { bastion: l.view.id, target, openedAt: opened.toISOString(), ms: now().getTime() - opened.getTime() } });
    });
    return pipe;
  }

  async function read(jobId: string, r: BastionRead): Promise<{ status: number; body: Buffer } | { status: number; no: string }> {
    const v = live.get(jobId)?.view;
    if (v && r.secret && !(v.secrets ?? []).includes(r.secret)) return { status: 404, no: `the job's bastion holds no vault secret ${r.secret}: stop it, then ask for one with --secrets "${r.secret}"` };
    const started = now();
    const pipe = await relay(jobId, r.target, (local) => readCommand(local, r));
    if ('no' in pipe) return pipe;
    const got = await new Promise<{ out: Buffer } | { tooBig: true }>((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      pipe.on('data', (d: Buffer) => {
        size += d.length;
        if (size > READ_MAX_BYTES + 8) { pipe.destroy(); resolve({ tooBig: true }); } else chunks.push(d);
      });
      pipe.once('close', () => resolve({ out: Buffer.concat(chunks) }));
      pipe.once('error', () => undefined);
      pipe.end(r.data ?? '');
    });
    const a = 'tooBig' in got ? { problem: `its answer is over ${READ_MAX_BYTES} bytes: narrow the query` } : readAnswer(got.out, pipe.stderr());
    o.record({
      type: 'bastion.read', jobId,
      data: { bastion: v!.id, target: r.target, method: r.method, path: r.path.slice(0, 500), ...('status' in a ? { status: a.status, bytes: a.body.length } : { problem: a.problem }), ms: now().getTime() - started.getTime() },
    });
    if ('problem' in a) return { status: 'tooBig' in got ? 413 : 502, no: `the read of ${r.target}${r.path} in the box gave no answer: ${a.problem}` };
    return a;
  }
}
