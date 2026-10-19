// This hopper's job leases (issue #1662, design.md "Several hoppers on one database"). A claim takes the job's lease in its
// transaction, and the runner takes it again before it drives a job; a lease is renewed every third of its time while the
// runner drives the job, and released when the run ends or the hopper stops. A job whose lease another hopper took (this
// one was cut off from the database past its lease) is dropped here, and nothing more is written for it. A job claimed or
// running that no live lease holds is taken over: the same recovery as at a restart, from what the store keeps. A
// person's cancel or park of a job another hopper drives is relayed on its lease, and that hopper acts on it at its tick.
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { RelayedAct } from '../domain/job-leases.ts';
import type { UserStore } from '../domain/ports.ts';
import type { EngineContext } from './context.ts';
import { takeOver } from './recovery.ts';
import type { Runner } from './runner.ts';

/** How long a job lease holds without a renewal: the most a hopper that crashed keeps its jobs from the others. */
export const JOB_LEASE_MS = 60_000;

/** This engine's name as a lease owner: its host, pid and a nonce, so no other start takes it for its own. */
export const leaseOwner = (): string => `${hostname()}/${process.pid}/${randomUUID().slice(0, 8)}`;

export interface JobLeases {
  readonly owner: string;
  /** How long a lease holds without a renewal. */
  readonly leaseMs: number;
  /** Takes the job's lease for this hopper (`force`: whoever holds it); whether this hopper holds it. */
  take(jobId: string, force?: boolean): boolean;
  /** Releases this hopper's lease on the job. */
  release(jobId: string): void;
  /** The jobs another live hopper holds. */
  heldByOthers(): Set<string>;
  /** The jobs claimed or running that no live lease holds. */
  unheld(): string[];
  /** Renews this hopper's leases on the jobs it drives and releases the rest: the driven jobs whose lease it lost. */
  renew(driving: readonly string[]): string[];
  /** Keeps the leases of `jobIds` at each renewal until the answer is called: jobs a recovery took and decides on. */
  keep(jobIds: readonly string[]): () => void;
  /** Releases every lease of this hopper. */
  releaseAll(): void;
  /** Relays a person's act to the live hopper that holds the job's lease, when that is another one; whether it was relayed. */
  relay(jobId: string, act: RelayedAct): boolean;
  /** Takes the acts relayed to this hopper, each once. */
  relayed(): { jobId: string; act: RelayedAct }[];
  /** Takes the claim lock until the transaction ends: one hopper at a time claims this user's jobs. */
  lockClaims(): void;
}

/** The leases are timed on the database's clock (issue #1954), never on this host's: so no clock is given. */
export function createJobLeases(o: { store: Pick<UserStore, 'jobLeases'>; owner?: string; leaseMs?: number }): JobLeases {
  const owner = o.owner ?? leaseOwner(), leaseMs = o.leaseMs ?? JOB_LEASE_MS, repo = o.store.jobLeases;
  const kept = new Map<string, number>();
  return {
    owner, leaseMs,
    take: (jobId, force) => repo.take(jobId, { owner, ms: leaseMs }, force),
    release: (jobId) => repo.release(owner, [jobId]),
    heldByOthers: () => repo.heldByOthers(owner),
    unheld: () => repo.unheld(),
    renew(driving) {
      const held = new Set(repo.renew(owner, leaseMs));
      const left = [...held].filter((id) => !driving.includes(id) && !kept.has(id));
      if (left.length) repo.release(owner, left);
      return driving.filter((id) => !held.has(id));
    },
    keep(jobIds) {
      for (const id of jobIds) kept.set(id, (kept.get(id) ?? 0) + 1);
      return () => { for (const id of jobIds) { const n = (kept.get(id) ?? 1) - 1; if (n > 0) kept.set(id, n); else kept.delete(id); } };
    },
    releaseAll: () => repo.release(owner),
    relay: (jobId, act) => repo.relay(jobId, act, owner),
    relayed: () => repo.relayed(owner),
    lockClaims: () => repo.lockClaims(),
  };
}

/** What drives the leases: their renewal every third of their time, and a takeover on each tick. */
export interface LeaseKeeper {
  start(): void;
  /** The acts relayed to this hopper, done; then the jobs whose hopper stopped, taken over: one pass at a time. */
  tick(): void;
  /** Ends the renewals and releases every lease this hopper still holds: another hopper may take its jobs at once. */
  stop(): void;
}

/** `act`: a person's act relayed from another hopper, done here as that hopper's request would be. */
export function createLeaseKeeper(c: EngineContext, runner: Pick<Runner, 'driving' | 'drop' | 'reattach' | 'reattachWhenReachable'>, cleanup: (jobId: string) => Promise<void>, act: (jobId: string, act: RelayedAct) => void): LeaseKeeper {
  let timer: NodeJS.Timeout | undefined, taking = false;
  const renew = (): void => {
    try {
      for (const id of c.leases.renew(runner.driving())) {
        console.warn(`hopper: job ${id}: another hopper took its lease; this one stops driving it`);
        runner.drop(id);
      }
    } catch (e) { console.error('hopper: renewing the job leases failed', e); }
  };
  return {
    start() {
      timer = setInterval(renew, Math.floor(c.leases.leaseMs / 3));
      timer.unref();
    },
    tick() {
      if (c.stopping()) return;
      try {
        for (const r of c.leases.relayed()) {
          try { act(r.jobId, r.act); } catch (e) { console.warn(`hopper: job ${r.jobId}: the ${r.act.kind} another hopper relayed failed`, e); }
        }
      } catch (e) { console.error('hopper: reading the acts relayed to this hopper failed', e); }
      if (taking) return;
      taking = true;
      void takeOver(c, runner.driving()).then((r) => {
        if (c.stopping()) return;
        for (const id of r.toClean) void cleanup(id);
        for (const claim of r.reattach) runner.reattach(claim);
        for (const claim of r.awaiting) runner.reattachWhenReachable(claim);
      }).catch((e: unknown) => console.error('hopper: taking over the jobs of a stopped hopper failed', e)).finally(() => { taking = false; });
    },
    stop() {
      if (timer) clearInterval(timer);
      try { c.leases.releaseAll(); } catch (e) { console.error('hopper: releasing the job leases failed', e); }
    },
  };
}
