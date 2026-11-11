// Scope grants (issue #2923, design.md "Scope grants"): a person's grant of a job's ask is kept for the
// ask's scope — the box's template, or the Windows host of a step, and the job's repository — not for the job's item. A
// later job of any item that asks from the same scope gets the vault with no person, until a person revokes the grant.
// The template's approved scope still bounds what a granted job gets: the vault decides that, as for any grant.
import { TERMINAL_STATUSES, type Job, type JobStatus } from './types.ts';

/** Where a job asks the vault from: its box's template, or the Windows host its step runs on (issue #731). */
export type VaultPlace = { template: string } | { windowsHost: string };

/** What a scope grant covers: the place, and the job's repository (absent: a job of no repository). */
export interface VaultScope { repo?: string; template?: string; windowsHost?: string }

/**
 * A person's grant of a scope: its key, who granted it and when, and the jobs it granted, newest last. `runs`: a run card's
 * approval with allow again made it, so it approves later jobs' sandbox runs of its template too, not only their vault.
 */
export interface VaultScopeGrant extends VaultScope { key: string; by: string; at: string; jobs: string[]; runs?: true }

/** The jobs a scope grant keeps, newest last: what the Vault grants panel folds under its row. */
export const SCOPE_JOBS_KEPT = 20;

/** The scope of a job's ask from `place`. */
export const scopeOf = (job: Pick<Job, 'source'>, place: VaultPlace): VaultScope => ({ ...(job.source?.repo ? { repo: job.source.repo } : {}), ...place });

/** The key a scope is kept by: one row for each place and repository. */
export const scopeKeyOf = (s: VaultScope): string =>
  `${s.template !== undefined ? `template ${s.template}` : `windows host ${s.windowsHost ?? ''}`}, repo ${s.repo ?? '(none)'}`;

/** The grant with `job` added to its jobs, the newest kept; undefined when it holds the job already. */
export function withJob(g: VaultScopeGrant, job: string): VaultScopeGrant | undefined {
  if (g.jobs.includes(job)) return undefined;
  return { ...g, jobs: [...g.jobs, job].slice(-SCOPE_JOBS_KEPT) };
}

/** Who takes back the grant of an item whose newest job ended (issue #2923): the hopper, by itself. */
export const ENDED_BY = 'its job ended';

/** Who a scope grant names in `vault.granted` when it grants a later job with no person. */
export const scopeBy = (g: Pick<VaultScopeGrant, 'by'>): string => `scope grant by ${g.by}`;

/** A job a scope grant granted, as the panel shows it: its id, title and status, when it is kept. */
export interface VaultScopeJob { job: string; title?: string; status?: JobStatus; ended: boolean }

/** A scope grant as a person reads it: its jobs folded under it, and how many of them wait or are at work. */
export interface VaultScopeGrantView extends Omit<VaultScopeGrant, 'jobs'> { jobs: VaultScopeJob[]; live: number }

/** A scope grant with its jobs read from `get`, newest first. */
export function scopeGrantView(g: VaultScopeGrant, get: (id: string) => Job | undefined): VaultScopeGrantView {
  const jobs = [...g.jobs].reverse().map((id): VaultScopeJob => {
    const j = get(id);
    const title = j?.source?.title ?? j?.spec.goal;
    return { job: id, ...(title ? { title } : {}), ...(j ? { status: j.status } : {}), ended: !j || TERMINAL_STATUSES.includes(j.status) };
  });
  return { ...g, jobs, live: jobs.filter((j) => !j.ended).length };
}

/** The store of scope grants (tenant migration 109): one row for each scope key. */
export interface VaultScopeGrantRepository {
  get(key: string): VaultScopeGrant | undefined;
  list(): VaultScopeGrant[];
  put(grant: VaultScopeGrant): VaultScopeGrant;
  /** Whether there was one to remove. */
  remove(key: string): boolean;
}
