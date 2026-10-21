// The trust stamp in OpenFGA (issue #655, part 15; design.md "Trust stamps"), pure but for the edit: the tuples a live
// job's trust is, the minimum trust an admin sets on an operation profile, and how the hopper's own reading of a path
// (`trustedPath`) and a deny's reason take the minimum into account. The model's part is ./trust-model.ts.
import { TRUST_LEVELS, atLeast, type TrustLevel } from '../domain/trust-stamp.ts';
import { profileProblem } from '../domain/types.ts';
import type { AccessRepository, LiveRequesters, MinTrust, OperationProfile, RelationshipTuple, Requester, StoredTuple } from '../domain/types.ts';
import { AccessEditError } from './edits.ts';
import { jobObject, profileObject, profileOf, relationshipPath } from './objects.ts';

/** The levels a minimum trust may name: quarantined holds nothing, so it is none. */
export const MIN_TRUST_LEVELS = TRUST_LEVELS.filter((l) => l !== 'quarantined');

export const trustObject = (level: TrustLevel): string => `trust:${level}`;

/** The levels a job at `level` holds: its own and each one below it; quarantined, none. */
export const heldLevels = (level: TrustLevel): TrustLevel[] => (level === 'quarantined' ? [] : MIN_TRUST_LEVELS.filter((l) => atLeast(level, l)));

/** The tuples that say `job` (an object) holds `level`. */
export const holderTuples = (job: string, level: TrustLevel): RelationshipTuple[] =>
  heldLevels(level).map((l) => ({ subject: job, relation: 'holder', object: trustObject(l) }));

/** Each live job's trust as tuples; a job with no verified level holds none. */
export const trustTuples = (live: readonly LiveRequesters[]): RelationshipTuple[] =>
  live.flatMap(({ userId, jobs }) => jobs.flatMap((j) => (j.trust === undefined ? [] : holderTuples(jobObject({ userId, jobId: j.jobId }), j.trust))));

const isMin = (t: RelationshipTuple): boolean => t.relation === 'min_trust' && t.subject.startsWith('trust:');

/** Each minimum trust a profile has: every job (`job:*`) is gated by it. Written with the minimum, never stored. */
export const gateTuples = (tuples: readonly RelationshipTuple[]): RelationshipTuple[] =>
  tuples.filter(isMin).map((t) => ({ subject: 'job:*', relation: 'trust_gated', object: t.object }));

/** Each profile's minimum trust, as kept. */
export function minTrusts(stored: readonly StoredTuple[]): MinTrust[] {
  return stored.filter(isMin).flatMap((t) => {
    const profile = profileOf(t.object.replace(/^operation_profile:/, ''));
    return profile ? [{ profile, level: t.subject.slice('trust:'.length) as TrustLevel, setBy: t.writtenBy, setAt: t.writtenAt }] : [];
  });
}

/**
 * Sets a profile's minimum trust, or clears it (`null`): the one it had is revoked first. True when anything changed.
 * 400: not a profile the model can hold, or a minimum while the model lacks the trust relations (`gaps`).
 */
export function setMinTrust(repo: AccessRepository, profile: OperationProfile, level: TrustLevel | null, o: { by: string; at: string; gaps: readonly string[] }): boolean {
  const problem = profileProblem(profile);
  if (problem) throw new AccessEditError(400, problem);
  if (o.gaps.length > 0 && level !== null) throw new AccessEditError(400, `the access model lacks what a minimum trust needs: ${o.gaps.join(', ')}: add it in Users & access → Access`);
  const { by, at } = o, object = profileObject(profile);
  const had = repo.liveTuples().filter((t) => isMin(t) && t.object === object);
  if (level !== null && had.length === 1 && had[0]!.subject === trustObject(level)) return false;
  for (const t of had) repo.revokeTuple(t.seq, by, at);
  if (level !== null) repo.addTuple({ subject: trustObject(level), relation: 'min_trust', object }, by, at);
  return had.length > 0 || level !== null;
}

/**
 * The minimum's steps of a path from `requester` to `profile`: none when the profile has no minimum or the requester is
 * no job; the minimum and the job's holder tuple that meets it; undefined when the job does not hold it (no path).
 */
export function trustSteps(tuples: readonly RelationshipTuple[], requester: string, profile: OperationProfile): RelationshipTuple[] | undefined {
  const min = tuples.find((t) => isMin(t) && t.object === profileObject(profile));
  if (!min || !requester.startsWith('job:')) return [];
  const held = tuples.find((t) => t.subject === requester && t.relation === 'holder' && t.object === min.subject);
  return held ? [min, held] : undefined;
}

/** The hopper's reading of the path from `requester` to `profile` (`relationshipPath`), with the minimum's steps; undefined: none. */
export function trustedPath(tuples: readonly RelationshipTuple[], requester: string, profile: OperationProfile): RelationshipTuple[] | undefined {
  const path = relationshipPath(tuples, requester, profile);
  const steps = path && trustSteps(tuples, requester, profile);
  return path && steps ? [...path, ...steps] : undefined;
}

/** Why a job is no requester of the profile for its trust (`job j1 is at trust approved, below …`), or undefined. */
export function belowMinimum(live: readonly LiveRequesters[], stored: readonly StoredTuple[], r: Requester, profile: OperationProfile, doing: string): string | undefined {
  if (r.kind !== 'job') return undefined;
  const min = minTrusts(stored).find((m) => profileObject(m.profile) === profileObject(profile));
  if (!min) return undefined;
  const trust = live.find((l) => l.userId === r.userId)?.jobs.find((j) => j.jobId === r.jobId)?.trust;
  if (trust !== undefined && trust !== 'quarantined' && atLeast(trust, min.level)) return undefined;
  return `job ${r.jobId} is ${trust === undefined ? 'at no trust level that verifies' : `at trust ${trust}`}, below the minimum trust ${min.level} to ${doing}`;
}
