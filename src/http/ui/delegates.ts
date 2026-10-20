// Delegate approvers at the approval routes (issue #1138, design.md "Delegate approvers"): who an approval records, and
// the approver policy. A request whose API token is a delegate approver's records `by` as the delegate and the person it
// acts for, another API token's as its label and its person (issue #2229); the routes ask `refuseDenied` before they approve, so what the policy names stays the owner's. Its scopes,
// checked at the door (./api-tokens.ts), already keep it to the approval routes.
import { apiTokenBy, delegateBy, deniedBy, type DelegatePolicy } from '../../domain/delegates.ts';
import type { Identity, SessionKind } from '../../domain/types.ts';
import { HttpError } from '../errors.ts';
import type { ApiGrants } from './api-grants.ts';
import { personOf } from './sessions.ts';

/** A delegate approver acting: its name, the person it acts for, and its approver policy. */
export interface Delegate extends DelegatePolicy { name: string; person: string }

/** The delegate approver the request's API token is of, or undefined: the request is a person's, or another grant's. */
export function delegateOf(grants: Pick<ApiGrants, 'live'>, s: { identity: Identity; email?: string; grantId?: string }): Delegate | undefined {
  const g = s.grantId === undefined ? undefined : grants.live(s.grantId);
  return g?.delegate ? { name: g.label, person: personOf(s), deny: g.delegate.deny } : undefined;
}

/**
 * Who an approval records: a delegate and the person it acts for; another API token's label and its person (issue #2229),
 * so an approval an agent made shows as that agent's key; else the person.
 */
export const approverOf = (d: Delegate | undefined, s: { identity: Identity; email?: string; kind?: SessionKind; label?: string }): string =>
  d ? delegateBy(d.name, d.person) : s.kind === 'api' && s.label ? apiTokenBy(s.label, personOf(s)) : personOf(s);

/** 403 when the delegate's approver policy names one of what the approval touches; a person's approval passes. */
export function refuseDenied(d: Delegate | undefined, names: readonly (string | undefined)[], doing: string): void {
  if (!d) return;
  const hit = deniedBy(d.deny, names.filter((n): n is string => n !== undefined && n !== ''));
  if (hit) throw new HttpError(403, `${doing} is refused: the delegate ${d.name}'s approver policy denies ${hit.entry} (${hit.name}); it stays ${d.person}'s`);
}
