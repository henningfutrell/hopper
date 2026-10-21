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
// its refusal, is an event on the job's timeline.
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { OperationProfile } from '../domain/access.ts';
import type { Minted, MintReach } from '../domain/minting.ts';
import type { Job, NewEvent } from '../domain/types.ts';
import type { TemplateView } from '../domain/vault.ts';
import type { BoxPipe } from '../domain/sandboxes.ts';
import type { BastionEnd, BastionView } from '../domain/bastions.ts';
import type { NeedBox, NeedBoxIo, NeedBoxResult, RunningNeedBox } from './need-box.ts';
import {
  bastionEnv, bastionTokens, placeTargets, relayCommand, targetsOutside, targetText, BASTION_MAX_MS, BASTION_RENEW_MS, BASTION_TTL_MS, type BastionCredential, type BastionTarget, type PlacedTarget,
} from './bastion.ts';

export type { BastionEnd, BastionView } from '../domain/bastions.ts';

/** How often the hopper looks whether a bastion's job is still at work and its TTL has passed. */
const CHECK_MS = 5_000;
/** The most of a bastion's output the hopper keeps: its tail. */
const LOG_TAIL = 4096;

export interface BastionsOptions {
  userId: string;
  /** The vault's mint for one observe of the bastion's box (src/vault/need-mint.ts, as a need box's). */
  mint(ask: { template: string; step: string; job: string; profile: OperationProfile }): Promise<{ minted: Minted; reach: MintReach } | { refused: string }>;
  /** The bastion's box ended: each token minted for it stops working (the vault's `releaseMints`). Never rejects. */
  release(box: string): Promise<void>;
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
}

export interface Bastions {
  /**
   * Starts the job's bastion of `template` to `targets` (the template ready, its runs approved for the job: the caller
   * checks), or answers the one it has with the same template and targets; a no with its HTTP status.
   */
  start(job: Job, template: TemplateView, targets: readonly BastionTarget[]): Promise<BastionView | { status: number; no: string }>;
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
   */
  relay(jobId: string, target: string): Promise<BoxPipe | { status: number; no: string }>;
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
}

const sameTargets = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join(' ') === [...b].sort().join(' ');
const profileText = (p: OperationProfile): string => `${p.operation} on ${p.asset.kind} ${p.asset.name}`;

export function createBastions(o: BastionsOptions): Bastions {
  const newId = o.newId ?? (() => randomUUID());
  const now = o.now ?? (() => new Date());
  const ttlMs = o.ttlMs ?? BASTION_TTL_MS;
  const live = new Map<string, Live>();
  const last = new Map<string, BastionView>();

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

  /** Asks the bastion to end, once: the first reason is the one kept. */
  const end = (l: Live, why: NonNullable<Live['why']>): void => {
    if (l.why) return;
    l.why = why;
    l.stop.abort();
  };

  /** Keeps its end: its tokens released, its timers stopped, the end an event on the job's timeline. */
  const ended = async (l: Live, r: NeedBoxResult): Promise<void> => {
    for (const t of l.timers) clearInterval(t);
    for (const p of l.open) p.destroy();
    rmSync(join(o.dir, l.view.id), { recursive: true, force: true });
    await o.release(l.view.box).catch(() => undefined);
    const why = l.why ?? { end: 'failed' as const, problem: r.problem ?? `its box ended with ${r.exit}` };
    const view: BastionView = {
      ...l.view, state: 'ended', endedAt: now().toISOString(), ended: why.end, ...(why.by ? { endedBy: why.by } : {}), ...(why.problem ? { problem: why.problem } : {}),
    };
    live.delete(l.view.jobId);
    last.set(l.view.jobId, view);
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
    async start(job, template, targets) {
      const placing = placeTargets(targets, template.profiles);
      if (typeof placing === 'string') return { status: 400, no: placing };
      const outside = targetsOutside(template, targets);
      if (outside) return { status: 403, no: outside.why === 'unnamed' ? `${outside.no}: ask for a template with --targets "${outside.targets.join(' ')}"` : outside.no };
      const asked = placing.placed.map(targetText);
      const running = live.get(job.id);
      if (running) {
        if (running.view.template === template.name && sameTargets(running.view.targets.map((t) => t.target), asked)) return viewOf(job.id)!;
        return { status: 409, no: `this job's bastion ${running.view.id} runs: stop it first (sh "$HOPPER_SKILL" bastion stop), then ask for the new one` };
      }
      const run = o.run;
      if (!run) return { status: 503, no: 'this hopper runs no sandbox: it is given no container runtime (docs/deploy.md "Sandboxes the hopper starts")' };
      const id = newId();
      const box = `hopper-bastion-${template.name}-${id.slice(0, 8)}`;
      const credentials = await mintAll({ template: template.name, box, jobId: job.id }, placing.observes);
      if (typeof credentials === 'string') {
        await o.release(box).catch(() => undefined);
        return { status: 403, no: credentials };
      }
      // A second ask while the first one minted: the first one is the bastion.
      if (live.has(job.id)) {
        await o.release(box).catch(() => undefined);
        return viewOf(job.id)!;
      }
      const at = now();
      const l: Live = {
        view: {
          id, jobId: job.id, template: template.name, box, targets: placing.placed.map((t) => ({ target: targetText(t), local: t.local })), state: 'starting',
          startedAt: at.toISOString(), expiresAt: new Date(at.getTime() + ttlMs).toISOString(), log: '',
        },
        placed: placing.placed, observes: placing.observes, stop: new AbortController(), open: new Set(), timers: [], done: Promise.resolve(),
      };
      live.set(job.id, l);
      o.record({ type: 'bastion.started', jobId: job.id, data: { bastion: id, template: template.name, box, targets: asked, expiresAt: l.view.expiresAt } });
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
      mkdirSync(join(o.dir, id), { recursive: true, mode: 0o700 });
      l.done = run({
        name: box, template: { image: t.image, ...(t.tools ? { tools: t.tools } : {}), ...(t.egress?.length ? { egress: t.egress } : {}), ...(t.readOnly ? { readOnly: true as const } : {}), ...(t.limits ? { limits: t.limits } : {}) },
        // Part 5: a read-only template's box runs behind the egress proxy, which lets its tokens' cluster through.
        env: bastionEnv(l.placed, credentials), reaches: credentials.map((c) => c.reach), timeoutMs: BASTION_MAX_MS, dir: join(o.dir, id), files: { secrets: bastionTokens(credentials) },
      }, {
        log: (chunk) => { l.view.log = (l.view.log + chunk).slice(-LOG_TAIL); }, signal: l.stop.signal, running: renewing,
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

    async relay(jobId, target) {
      const l = live.get(jobId);
      if (!l || l.why) return { status: 404, no: 'this job has no bastion that runs: ask for one with sh "$HOPPER_SKILL" bastion --template NAME --targets "..." --why "..."' };
      const t = l.placed.find((x) => targetText(x) === target);
      if (!t) return { status: 404, no: `the job's bastion forwards to ${l.view.targets.map((x) => x.target).join(', ')}; not to ${target}` };
      if (l.view.state !== 'running') return { status: 409, no: `the job's bastion ${l.view.id} is ${l.view.state}: ask again in a few seconds` };
      if (!l.pipe) return { status: 503, no: 'the container runtime of the bastion\'s box starts no command in it: no relay reaches it' };
      const said = await o.mayRelay({ jobId, template: l.view.template, target }).catch((e: unknown) => ({ allowed: false, reason: `Access could not be asked: ${e instanceof Error ? e.message : String(e)}` }));
      if (!said.allowed) {
        o.record({ type: 'bastion.relay_refused', jobId, data: { bastion: l.view.id, target, reason: said.reason } });
        return { status: 403, no: `Access denies the relay to ${target}: ${said.reason}` };
      }
      let pipe: BoxPipe;
      try {
        pipe = await l.pipe(relayCommand(t.local));
      } catch (e) {
        return { status: 502, no: `the relay did not reach ${target} in the box: ${e instanceof Error ? e.message : String(e)}` };
      }
      if (l.why) { pipe.destroy(); return { status: 404, no: `the job's bastion ${l.view.id} ended` }; }
      l.open.add(pipe);
      used(l);
      const opened = now();
      pipe.once('close', () => {
        l.open.delete(pipe);
        used(l);
        o.record({ type: 'bastion.relayed', jobId, data: { bastion: l.view.id, target, openedAt: opened.toISOString(), ms: now().getTime() - opened.getTime() } });
      });
      return pipe;
    },

    async stopAll() {
      const all = [...live.values()];
      for (const l of all) end(l, { end: 'stopped', by: 'the hopper' });
      await Promise.allSettled(all.map((l) => l.done));
    },
  };
}
