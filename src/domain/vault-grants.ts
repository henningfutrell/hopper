// Vault grants (issue #652, requirement 5, design.md "Vault grants"): a job gets nothing from the vault's helper — no vault
// secret, no minted credential — until a person grants it the vault. A job asks; a person grants, through the UI session,
// and Access decides (OpenFGA `vault_grant#can_grant`). The grant is kept for the job's item, so Run again, Rework and
// Retry keep it; the box's template still bounds what a granted job gets.
import { authorizesVault, DIRECT_SOURCE, directKey, type DirectJob } from './direct-jobs.ts';
import { OPERATOR_CLI_NAME, type ActionVia } from './failures.ts';
import { TERMINAL_STATUSES, type Job, type JobStatus } from './types.ts';

/** A person's grant of the vault to a job's item: the item's key, the job it was granted on, who and when. */
export interface VaultGrant { key: string; job: string; by: string; at: string }

/**
 * A job that asked the vault with no grant: the job, its item's key, where it asked from — its box and template, or the
 * Windows host its step runs on (issue #731) —, what it asked for (a secret's name, or `<kind> <operation> <asset>` for a
 * mint), first asked when. Kept in the hopper's memory only. `item`: what it covers, as the view answers it (issue #1124).
 */
export interface VaultGrantAsk { job: string; key: string; machine?: string; template?: string; windowsHost?: string; names: string[]; askedAt: string; item?: VaultGrantItem }

/** What a grant is kept for: the job's item (its source key); a job of no source, the job itself. */
export const grantKeyOf = (job: Pick<Job, 'id' | 'source'>): string => job.source?.key ?? job.id;

/** Why a job with no grant gets nothing: what the job is told, and what `vault.refused` records. */
export const noGrant = (job: string): string => `job ${job.slice(0, 8)} has no vault grant: a person grants it the vault on Access requests, then ask again`;

/**
 * What a grant covers, as a person reads it (issue #1124): the item's title, its repository and link, its newest job and
 * that job's status. Stale: no job of the item waits or is at work — the grant gives nothing now, and a person may revoke it.
 */
export interface VaultGrantItem { title: string; repo?: string; url?: string; job?: string; status?: JobStatus; stale: boolean }

/**
 * A grant with what it covers and how it was made (issue #1124): `grant` — Grant on Access requests, an API token, or
 * `hopper vault grant` — or `submit`, a direct job's submission that authorized the vault. `via`, where it is known: the
 * operator CLI's grant, or the submission's own way; `command`, the operator CLI command that made it.
 */
export interface VaultGrantView extends VaultGrant { item: VaultGrantItem; made: 'grant' | 'submit'; via?: ActionVia; command?: string }

/** The item a key names, read from its newest job and, for a direct job, its submission. */
export function grantItemOf(key: string, o: { newest?: Job | undefined; direct?: DirectJob | undefined }): VaultGrantItem {
  const { newest, direct } = o;
  const title = direct?.title ?? newest?.source?.title ?? newest?.spec.goal ?? key;
  const repo = newest?.source?.repo ?? direct?.repo, url = newest?.source?.url;
  return {
    title, ...(repo ? { repo } : {}), ...(url ? { url } : {}),
    ...(newest ? { job: newest.id, status: newest.status } : {}),
    stale: !newest || TERMINAL_STATUSES.includes(newest.status),
  };
}

/** The direct job's id a key names, if it names one. */
export const directIdOf = (key: string): string | undefined => (key.startsWith(`${DIRECT_SOURCE}:`) ? key.slice(DIRECT_SOURCE.length + 1) : undefined);

/** A grant as a person reads it (issue #1124). */
export function grantView(g: VaultGrant, o: { newest?: Job | undefined; direct?: DirectJob | undefined }): VaultGrantView {
  const { direct } = o;
  // A direct job's submission that authorized the vault granted it, by its submitter (src/direct-jobs/index.ts).
  const submit = direct !== undefined && g.key === directKey(direct.id) && authorizesVault(direct) && direct.submittedBy.person === g.by;
  const via: ActionVia | undefined = submit ? direct.submittedBy.via : g.by === OPERATOR_CLI_NAME ? 'cli' : undefined;
  const command = via !== 'cli' ? undefined : submit ? 'hopper job submit --authorize vault' : `hopper vault grant ${g.job}`;
  return { ...g, item: grantItemOf(g.key, o), made: submit ? 'submit' : 'grant', ...(via ? { via } : {}), ...(command ? { command } : {}) };
}
