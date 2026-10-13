// Remembered write approvals (issue #1001, design.md "Fewer sandbox approvals"): a person's explicit approval of a write,
// sync or apply on an asset is remembered per asset and access, until an admin forgets it or the admin-set time limit
// ends. A template the hopper makes for a job, or a sandbox run of a template, whose every change is remembered — no vault
// secret, and each read approved with no person — needs no person: `by` a remembered write approval. Pure.
import type { Asset, Operation, OperationProfile } from './access.ts';
import { inReadPolicy, type ReadPolicy } from './read-policy.ts';
import { autoApproves, NO_PERSON, REMEMBERED_APPROVER, type SandboxApprovals } from './sandbox-approvals.ts';

export { REMEMBERED_APPROVER };

/** One remembered approval: a change on an asset, who approved it, and when. Kept in the user's settings (key `rememberedWrites`). */
export interface RememberedWrite { operation: Exclude<Operation, 'read'>; asset: Asset; by: string; at: string }

/** A remembered approval as the vault's view shows it: when it ends; absent, it is kept until it is forgotten. */
export interface RememberedWriteView extends RememberedWrite { expiresAt?: string }

/** Never set: a week. */
export const DEFAULT_REMEMBER_HOURS = 168;
/** The longest time limit: a year. 0: until forgotten. */
export const REMEMBER_HOURS_MAX = 8760;

/** The time limit in force, in hours; 0 keeps each approval until it is forgotten. */
export const rememberHoursOf = (a: SandboxApprovals | undefined): number => a?.rememberWritesHours ?? DEFAULT_REMEMBER_HOURS;

const same = (a: { operation: string; asset: Asset }, b: { operation: string; asset: Asset }): boolean =>
  a.operation === b.operation && a.asset.kind === b.asset.kind && a.asset.name === b.asset.name;

const endOf = (w: RememberedWrite, hours: number): Date | undefined => (hours > 0 ? new Date(new Date(w.at).getTime() + hours * 3_600_000) : undefined);

/** The approvals not ended at `now`, each with its end. A time limit set later counts at once. */
export function liveWrites(list: readonly RememberedWrite[], hours: number, now: Date): RememberedWriteView[] {
  return list.flatMap((w) => {
    const end = endOf(w, hours);
    if (end && end.getTime() <= now.getTime()) return [];
    return [end ? { ...w, expiresAt: end.toISOString() } : { ...w }];
  });
}

/** The list after a person approved `p`: remembered (in place of one for the same asset and access); a read never is. Ended ones go. */
export function remembering(list: readonly RememberedWrite[], p: OperationProfile, by: string, now: Date, hours: number): RememberedWrite[] {
  const kept = liveWrites(list, hours, now).map(({ expiresAt: _end, ...w }) => w);
  if (p.operation === 'read') return kept;
  return [...kept.filter((w) => !same(w, p)), { operation: p.operation, asset: { kind: p.asset.kind, name: p.asset.name }, by, at: now.toISOString() }];
}

/** The list without the approval for `p`'s asset and access. */
export const forgetting = (list: readonly RememberedWrite[], p: { operation: string; asset: Asset }): RememberedWrite[] => list.filter((w) => !same(w, p));

/**
 * Whether remembered approvals cover a template: it holds no vault secret, names at least one change, each change is
 * remembered, and each read is approved with no person (`readApproved`). Reads only are never covered here: they are
 * the read policy's and the auto-approve policy's.
 */
export function rememberedCovers(t: { secrets: readonly string[]; profiles: readonly OperationProfile[] }, live: readonly RememberedWrite[], readApproved: (p: OperationProfile) => boolean): boolean {
  if (t.secrets.length > 0) return false;
  const changes = t.profiles.filter((p) => p.operation !== 'read');
  return changes.length > 0 && changes.every((p) => live.some((w) => same(w, p))) && t.profiles.filter((p) => p.operation === 'read').every(readApproved);
}

/** Whether a read is approved with no person: the read policy holds its asset, or the auto-approve policy holds low. */
export const readApprovedWithoutPerson = (policy: ReadPolicy | undefined, approvals: SandboxApprovals | undefined) =>
  (p: OperationProfile): boolean => inReadPolicy(policy, p.asset) || autoApproves(approvals, 'low');

/** Where a user keeps the approvals: their settings (src/domain/settings-store.ts). */
interface RememberedStore {
  getRememberedWrites(): RememberedWrite[];
  setRememberedWrites(list: readonly RememberedWrite[]): void;
  getSandboxApprovals(): SandboxApprovals | undefined;
}

/** Remembers a person's approval of a change, for its asset and access; a read, or an approval no person gave, is not. */
export function rememberApproval(s: RememberedStore, p: OperationProfile, by: string, now: Date): void {
  if (p.operation === 'read' || NO_PERSON.includes(by)) return;
  s.setRememberedWrites(remembering(s.getRememberedWrites(), p, by, now, rememberHoursOf(s.getSandboxApprovals())));
}
