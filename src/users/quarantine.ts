// What a quarantine takes back (issue #655 part 6, design.md "Trust stamps"): a person's quarantine, or the second deny at
// gate 2, revokes the vault grant of the job's item, and the job's need, box and Windows steps may no longer run — a step
// that runs stops at its next look (5 s), one that waits ends cancelled, and its minted credentials end with it. The lift
// lets steps run again; the grant stays revoked, and a person grants it again.
import type { UserStore } from '../domain/ports.ts';
import type { JobRepository } from '../domain/store.ts';
import type { DomainEvent } from '../domain/types.ts';
import { AT_WORK } from '../vault/box.ts';
import type { Vault } from '../vault/vault.ts';

/** Whether a job's steps may run: it is at work, and its proxy token opens the hopper's doors (not quarantined). */
export function stepsMayRun(jobs: Pick<JobRepository, 'get' | 'opensDoors'>): (jobId: string) => boolean {
  return (jobId) => {
    const job = jobs.get(jobId);
    return job !== undefined && AT_WORK.includes(job.status) && jobs.opensDoors(job);
  };
}

/** Who takes a quarantined job's grant back: the quarantine, and the person who quarantined it. */
export const quarantineRevoker = (person: unknown): string => typeof person === 'string' ? `quarantine by ${person}` : 'quarantine';

/** Follows one user's event log: each `job.quarantined` revokes the item's grant, after the append. Returns the unsubscribe. */
export function revokeOnQuarantine(o: { store: Pick<UserStore, 'events'>; vault: Pick<Vault, 'revokeGrant'> }): () => void {
  return o.store.events.subscribe((e: DomainEvent) => {
    if (e.type !== 'job.quarantined' || !e.jobId) return;
    const jobId = e.jobId, by = quarantineRevoker(e.data?.person);
    // A listener must not re-enter the store at once. No grant to revoke is no problem: the item had none.
    setImmediate(() => { o.vault.revokeGrant?.(jobId, by); });
  });
}
