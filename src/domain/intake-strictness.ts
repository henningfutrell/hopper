// Intake strictness (issue #655 part 3, design.md "Trust stamps"): brake 1 — the trust level a job's stamp needs before
// the job starts, per job source and per job repository. An admin sets it in Settings → Intake; the decider reads it at
// each Decision, so a change applies at the next one and never needs a restart. A tightened brake holds a waiting job
// that no longer passes; a running job keeps its doors (part 2), but gate 2 asks a person for its privileged requests
// while it is below the brake (part 12). Pure.
import type { JobSourceRef } from './types.ts';
import type { TrustLevel } from './trust-stamp.ts';

/** Loosest first. */
export const INTAKE_STRICTNESS = ['open', 'standard', 'strict', 'closed'] as const;
export type Strictness = typeof INTAKE_STRICTNESS[number];

/** The level each strictness needs: `open` lets a screened job run, `closed` only the owner's own items. */
export const STRICTNESS_MIN: Readonly<Record<Strictness, TrustLevel>> = { open: 'screened', standard: 'approved', strict: 'trusted', closed: 'owner' };

/**
 * The brake: `default` for every job, `sources` by the configured source name, `repos` by `owner/name`, lowercased. The
 * most specific wins: the job's repository, else its source, else the default.
 */
export interface IntakeStrictness {
  default: Strictness;
  sources: Record<string, Strictness>;
  repos: Record<string, Strictness>;
}

export const DEFAULT_INTAKE_STRICTNESS: IntakeStrictness = { default: 'standard', sources: {}, repos: {} };

/** What the brake asks of one job: the level it needs, the strictness that sets it, and where that was set. */
export interface Brake { min: TrustLevel; strictness: Strictness; at: 'default' | { source: string } | { repo: string } }

/** The brake on a job from `source` (a job of no source: the default). */
export function brakeOf(s: IntakeStrictness, source: Pick<JobSourceRef, 'source' | 'repo'> | undefined): Brake {
  const repo = source?.repo?.toLowerCase();
  const byRepo = repo !== undefined ? s.repos[repo] : undefined;
  if (byRepo && repo) return { min: STRICTNESS_MIN[byRepo], strictness: byRepo, at: { repo } };
  const bySource = source ? s.sources[source.source] : undefined;
  if (bySource && source) return { min: STRICTNESS_MIN[bySource], strictness: bySource, at: { source: source.source } };
  return { min: STRICTNESS_MIN[s.default], strictness: s.default, at: 'default' };
}

/** The brake on `job` under the setting `s` (none kept: the default): what the store's gate 2 reads at each ask (part 12). */
export const jobBrake = (s: IntakeStrictness | undefined, job: { source?: Pick<JobSourceRef, 'source' | 'repo'> }): Brake =>
  brakeOf(s ?? DEFAULT_INTAKE_STRICTNESS, job.source);

/** Where a brake was set, in plain words. */
export const brakeWhere = (b: Brake): string =>
  b.at === 'default' ? 'by default' : 'repo' in b.at ? `for ${b.at.repo}` : `for the source ${b.at.source}`;
