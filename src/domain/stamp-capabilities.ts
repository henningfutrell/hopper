// The request's capabilities against the stamp's (issue #655, part 16; design.md "Trust stamps"): gate 2's policy stage
// at the skill broker. A job's trust stamp may ask only for the operation profiles whose minimum trust (part 15) its level
// meets. A need above it is outside the stamp: declined by policy, before Jev or a person reads it, and the job's trust
// stays ("deny by policy: an event, and the stamp stays"). Pure.
import type { MinTrust, OperationProfile } from './access.ts';
import { atLeast, type TrustLevel } from './trust-stamp.ts';

/** Who declines a sandbox run outside the job's stamp: no person, so it lowers no trust. */
export const MIN_TRUST_DECLINER = 'the minimum trust';

const same = (a: OperationProfile, b: OperationProfile): boolean => a.operation === b.operation && a.asset.kind === b.asset.kind && a.asset.name === b.asset.name;

/**
 * Why `profiles` are outside the stamp of a job at `level` (undefined: its stamp does not verify, so it meets no minimum):
 * the first one whose minimum trust the level does not meet; undefined: every one is inside.
 */
export function outsideStamp(level: TrustLevel | undefined, profiles: readonly OperationProfile[], mins: readonly MinTrust[]): string | undefined {
  for (const p of profiles) {
    const min = mins.find((m) => same(m.profile, p));
    if (!min || (level !== undefined && level !== 'quarantined' && atLeast(level, min.level))) continue;
    const to = `the minimum trust ${min.level} to ${p.operation} on ${p.asset.kind} ${p.asset.name}`;
    return level === undefined ? `the job has no trust stamp that verifies, so it meets no minimum trust: ${to}` : `the job's trust stamp is ${level}, below ${to}`;
  }
  return undefined;
}
