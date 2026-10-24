// The read policy (issue #716, design.md "Templates on request"): the assets a user lets the hopper approve read on with
// no person, for a template a job asks for. Each entry is an asset as Access names it (`cluster/lab`), or one that ends
// in `*` (`aws-account/*`, `namespace/lab/*`): every asset of that kind whose name starts with what is before the `*`.
// Never write, sync or apply, and never a database (issue #2231): those always wait for a person. Empty, or never set:
// the hopper approves nothing by itself. Pure.
import { ASSET_KINDS, type Asset } from './access.ts';

/** The most entries a read policy holds. */
export const READ_POLICY_MAX = 64;

/** A user's read policy, kept in their settings. */
export interface ReadPolicy { assets: string[] }

/** What may stand before a trailing `*`, or be a whole asset name: an asset name's characters (ASSET_NAME), any length. */
const NAME_PART = /^[A-Za-z0-9][A-Za-z0-9._/+=,-]{0,199}$/;

/** Why `entry` is not one the policy can hold, or undefined. */
function entryProblem(entry: string): string | undefined {
  const i = entry.indexOf('/');
  const kind = entry.slice(0, i);
  const name = entry.slice(i + 1);
  if (i <= 0 || name === '') return `${entry}: write <kind>/<asset> or <kind>/<prefix>*, e.g. cluster/lab or aws-account/*`;
  if (!(ASSET_KINDS as readonly string[]).includes(kind)) return `${entry}: the asset kind is one of ${ASSET_KINDS.join(', ')}`;
  if (kind === 'database') return `${entry}: the read policy holds no database: a person approves each database read`;
  const star = name.indexOf('*');
  if (star !== -1 && star !== name.length - 1) return `${entry}: a * stands only at the end`;
  const prefix = star === -1 ? name : name.slice(0, -1);
  if (prefix !== '' && !NAME_PART.test(prefix)) return `${entry}: write <kind>/<asset> or <kind>/<prefix>*, e.g. cluster/lab or aws-account/*`;
  return undefined;
}

/** Why `entries` is not a read policy the hopper can keep, or undefined. */
export function readPolicyProblem(entries: readonly string[]): string | undefined {
  if (entries.length > READ_POLICY_MAX) return `a read policy holds at most ${READ_POLICY_MAX} entries`;
  return entries.map(entryProblem).find((p) => p !== undefined);
}

/** Whether the policy holds read on `asset`. No policy holds nothing. */
export function inReadPolicy(policy: ReadPolicy | undefined, asset: Asset): boolean {
  return (policy?.assets ?? []).some((entry) => {
    const [kind, ...rest] = entry.split('/');
    const name = rest.join('/');
    if (kind !== asset.kind || asset.kind === 'database') return false;
    return name.endsWith('*') ? asset.name.startsWith(name.slice(0, -1)) : asset.name === name;
  });
}
