// A sandbox's credentials end with it (issue #1371, decision #1394, design.md "Sandboxes are fresh and leave nothing"
// part 7). Each Kubernetes token minted for a need box or a check box is bound to a Secret of its own (`bindTo`); the
// sandbox holds that binding until it ends, whatever its outcome, and its release deletes the Secret, so the API server
// refuses the token at once. Each binding is recorded before the minter makes its Secret (`vault.binding_named`, issue
// #1628) and again in its mint's event (`vault.minted`, `vault.check_minted`: `bound`), and each unbind is `vault.unbound`: a binding that a hopper that stopped, or an unbind that failed, left is unbound by the
// reconcile pass, at start and then periodically. An AWS session and an EKS token are bound to nothing: STS cannot end
// one session, so each lives to its floor (15 and 14 minutes).
import { randomUUID } from 'node:crypto';
import type { Clock } from '../domain/ports.ts';
import type { EventLog } from '../domain/store.ts';
import type { MintBinding } from '../domain/minting.ts';

/** Deletes a binding's Secret where the minting credential is: in the hopper, or in the vault's own container. */
export type UnbindFrom = (b: MintBinding) => Promise<{ ok: true } | { refused: string }>;

/** How far back the reconcile pass reads mints: a binding older than this is left (its token expired long since). */
export const RECONCILE_DAYS = 7;
/** How often the reconcile pass runs once the hopper started. */
export const RECONCILE_MS = 5 * 60_000;

/** The vault's side of a sandbox's end (issue #1371). `from`: where the minting credential is; by default, here. */
export interface MintReleases {
  /** Deletes the Secret a sandbox's token is bound to, here: with the minting credential that made it. */
  unbindFrom: UnbindFrom;
  /** A need box or a check box ended: each token minted for it is unbound. Never rejects. */
  releaseMints(box: string, from?: UnbindFrom): Promise<void>;
  /** Unbinds each token a sandbox that ended left bound: one a stopped hopper, or a failed unbind, left. */
  reconcileMints(from?: UnbindFrom): Promise<void>;
}

export interface MintBindings {
  /** A new name for the Secret a token is bound to. */
  name(): string;
  /** A binding of the sandbox `box` (a need box or a check box), held until its release; `job`: the job it serves. */
  hold(box: string, b: MintBinding, job?: string): void;
  /**
   * A binding held as `hold` does, and recorded (`vault.binding_named`), before the minter makes its Secret (issue #1628):
   * a hopper that stops in between leaves a Secret the reconcile pass still knows.
   */
  named(box: string, b: MintBinding, job?: string): void;
  /** The sandbox ended: each Secret its tokens are bound to is deleted. Never rejects; one that fails waits for the reconcile pass. */
  release(box: string, from?: UnbindFrom): Promise<void>;
  /** Unbinds each binding a mint of the last `RECONCILE_DAYS` recorded that no sandbox holds now, here or on another live hopper, and no `vault.unbound` ended. */
  reconcile(from?: UnbindFrom): Promise<void>;
}

interface Held { box: string; binding: MintBinding; job?: string }

export function mintBindings(o: {
  events: Pick<EventLog, 'append' | 'between'>; clock: Clock; unbindFrom: UnbindFrom; logger: { warn(line: string): void }; newName?: () => string;
  /** The sandboxes another live hopper on this database runs now, by name (issue #1954): that hopper holds their bindings. */
  elsewhere?: () => ReadonlySet<string>;
}): MintBindings {
  const held = new Map<string, Held[]>();
  /** The Secrets unbound or being unbound by this process: a release and a reconcile pass never both delete one. */
  const busy = new Set<string>();
  const failed = new Map<string, string>();

  const unbind = async (h: Held, from: UnbindFrom): Promise<void> => {
    const { secret } = h.binding;
    if (busy.has(secret)) return;
    busy.add(secret);
    const r = await from(h.binding).catch((e: unknown) => ({ refused: e instanceof Error ? e.message : String(e) }));
    if ('refused' in r) {
      busy.delete(secret);
      if (failed.get(secret) !== r.refused) o.logger.warn(`hopper: the token of sandbox ${h.box} is still bound to ${h.binding.namespace}/${secret}: ${r.refused}; the reconcile pass tries again`);
      failed.set(secret, r.refused);
      return;
    }
    failed.delete(secret);
    o.events.append({ type: 'vault.unbound', ...(h.job ? { jobId: h.job } : {}), data: { box: h.box, ...(h.job ? { job: h.job } : {}), ...h.binding } });
  };

  const hold = (box: string, binding: MintBinding, job?: string): void => {
    held.set(box, [...(held.get(box) ?? []), { box, binding, ...(job ? { job } : {}) }]);
  };

  return {
    name: o.newName ?? (() => `hopper-mint-${randomUUID()}`),
    hold,
    named(box, binding, job) {
      // Held first: a reconcile pass that reads the event while the minter runs leaves the Secret to the sandbox.
      hold(box, binding, job);
      o.events.append({ type: 'vault.binding_named', ...(job ? { jobId: job } : {}), data: { box, ...(job ? { job } : {}), ...binding } });
    },
    async release(box, from = o.unbindFrom) {
      const mine = held.get(box) ?? [];
      held.delete(box);
      for (const h of mine) await unbind(h, from);
    },
    async reconcile(from = o.unbindFrom) {
      const since = new Date(o.clock.now().getTime() - RECONCILE_DAYS * 86_400_000).toISOString();
      const events = o.events.between(['vault.binding_named', 'vault.minted', 'vault.check_minted', 'vault.unbound'], since);
      const ended = new Set(events.filter((e) => e.type === 'vault.unbound').map((e) => (e.data as { secret?: unknown }).secret));
      const holding = new Set([...held.values()].flat().map((h) => h.binding.secret));
      const away = o.elsewhere?.() ?? new Set<string>();
      for (const e of events) {
        const d = e.data as { bound?: { namespace?: unknown; secret?: unknown }; namespace?: unknown; secret?: unknown; credential?: unknown; machine?: unknown; check?: unknown; box?: unknown; job?: unknown };
        // A named binding carries its Secret at the top; a mint's event, as `bound`.
        const { namespace, secret } = e.type === 'vault.binding_named' ? d : d.bound ?? {};
        if (typeof namespace !== 'string' || typeof secret !== 'string' || typeof d.credential !== 'string') continue;
        if (ended.has(secret) || holding.has(secret)) continue;
        const box = typeof d.machine === 'string' ? d.machine : typeof d.check === 'string' ? d.check : typeof d.box === 'string' ? d.box : 'a sandbox';
        if (away.has(box)) continue;
        await unbind({ box, binding: { credential: d.credential, namespace, secret }, ...(typeof d.job === 'string' ? { job: d.job } : {}) }, from);
        ended.add(secret);
      }
    },
  };
}

/** The reconcile pass on a timer (issue #1371): once at start, then every `RECONCILE_MS`; `stop` waits for a pass in flight. */
export function reconcilePass(reconcile: () => Promise<void>, logger: { warn(line: string): void }): { start(): void; stop(): Promise<void> } {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  const pass = (): void => {
    running ??= reconcile()
      .catch((e: unknown) => logger.warn(`hopper: the reconcile pass of the sandboxes' tokens failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => { running = undefined; });
  };
  return {
    start() {
      if (timer) return;
      pass();
      timer = setInterval(pass, RECONCILE_MS);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await running;
    },
  };
}
