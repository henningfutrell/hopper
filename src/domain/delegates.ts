// Delegate approvers (issue #1138, design.md "Delegate approvers"): a grant of the preset `delegate-approver`, which an
// owner mints for an agent that approves on their behalf what waits for a person — a job's vault grant ask, a template, a
// sandbox request — and nothing else. Its **approver policy** names what it may never approve: a deny entry matches any
// name the approval touches (a template, a secret, an asset, a machine) that holds it, in any case, so `prod` keeps every
// prod approval the owner's. Each approval it makes records the delegate and the person it acts for. Pure.
import type { OperationProfile } from './access.ts';

/** The preset a delegate approver is minted from (`GET /api/scopes`). */
export const DELEGATE_PRESET = 'delegate-approver';

/** What a delegate approver may do: read the vault's view, and approve, decline or deny what waits there. */
export const DELEGATE_SCOPES: readonly string[] = [
  'vault:read', 'jobs:grant-vault', 'jobs:deny-vault', 'vault:edit.approve-template', 'sandbox-requests:edit.approve', 'sandbox-requests:edit.decline',
  'sandbox-requests:edit.approve-run', 'sandbox-requests:edit.decline-run', // issue #2197: a run card
];

/** A delegate approver's approver policy: the names it may never approve. Empty: none. */
export interface DelegatePolicy { deny: string[] }

export const DENY_MAX = 32;
export const DENY_ENTRY_MAX = 100;

/** The name an approval by a delegate records as `by`: the delegate, and the person it acts for. */
export const delegateBy = (delegate: string, person: string): string => `${delegate} (delegate of ${person})`;

/** The first deny entry one of the names holds, in any case, and that name; undefined: the policy allows them all. */
export function deniedBy(deny: readonly string[], names: readonly string[]): { entry: string; name: string } | undefined {
  for (const entry of deny) {
    const e = entry.toLowerCase();
    const name = names.find((n) => n.toLowerCase().includes(e));
    if (name !== undefined) return { entry, name };
  }
  return undefined;
}

/** Why the deny entries are refused, or undefined. */
export function denyProblem(deny: readonly string[]): string | undefined {
  if (deny.length > DENY_MAX) return `an approver policy denies at most ${DENY_MAX} entries`;
  if (deny.some((d) => d.trim() === '')) return 'an approver policy entry is empty: name what the delegate may never approve, e.g. prod';
  if (deny.some((d) => d.length > DENY_ENTRY_MAX)) return `an approver policy entry is at most ${DENY_ENTRY_MAX} characters`;
  return undefined;
}

/** The names a template's approval touches: its own, its secrets and its profiles' assets, those that wait included. */
export function templateNames(t: { name: string; secrets: readonly string[]; profiles: readonly OperationProfile[]; pending?: { secrets: readonly string[]; profiles: readonly OperationProfile[] } }): string[] {
  const assets = (ps: readonly OperationProfile[]) => ps.map((p) => p.asset.name);
  return [...new Set([t.name, ...t.secrets, ...assets(t.profiles), ...(t.pending?.secrets ?? []), ...assets(t.pending?.profiles ?? [])])];
}
