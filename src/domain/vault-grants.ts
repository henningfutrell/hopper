// Vault grants (issue #652, requirement 5, design.md "Vault grants"): a job gets nothing from the vault's helper — no vault
// secret, no minted credential — until a person grants it the vault. A job asks; a person grants, through the UI session,
// and Access decides (OpenFGA `vault_grant#can_grant`). The grant is kept for the job's item, so Run again, Rework and
// Retry keep it; the box's template still bounds what a granted job gets.
import type { Job } from './types.ts';

/** A person's grant of the vault to a job's item: the item's key, the job it was granted on, who and when. */
export interface VaultGrant { key: string; job: string; by: string; at: string }

/**
 * A job on a box that asked the vault with no grant: the job, its item's key, its box and template, what it asked for
 * (a secret's name, or `<kind> <operation> <asset>` for a mint), first asked when. Kept in the hopper's memory only.
 */
export interface VaultGrantAsk { job: string; key: string; machine: string; template: string; names: string[]; askedAt: string }

/** What a grant is kept for: the job's item (its source key); a job of no source, the job itself. */
export const grantKeyOf = (job: Pick<Job, 'id' | 'source'>): string => job.source?.key ?? job.id;

/** Why a job with no grant gets nothing: what the job is told, and what `vault.refused` records. */
export const noGrant = (job: string): string => `job ${job.slice(0, 8)} has no vault grant: a person grants it the vault on the Vault page (Settings → Vault), then ask again`;
