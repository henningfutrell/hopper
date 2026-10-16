// The GitHub identity that acts for a job (issue #1380), pure: the hopper acts for a job with its own user's GitHub
// connection, and each GitHub request and push of the job names the login that acted (`as`). Before the job acted, its
// user's connected GitHub account is the one that will act.
import type { ConnectedAccountStatus, DomainEvent } from './wire.ts';

export type ActingIdentity = { kind: 'acted' | 'connected'; login: string } | { kind: 'none' };

const PROXY = new Set(['github_proxy.done', 'github_proxy.refused', 'github_proxy.failed']);

/** From the job's events, newest first, and its user's GitHub account as /api/connected-accounts reports it. */
export function actingIdentity(events: readonly DomainEvent[], account: ConnectedAccountStatus | undefined): ActingIdentity {
  for (const e of events) {
    const as = PROXY.has(e.type) ? (e.data as { as?: unknown }).as : undefined;
    if (typeof as === 'string') return { kind: 'acted', login: as };
  }
  return account?.state === 'connected' ? { kind: 'connected', login: account.account } : { kind: 'none' };
}

export function actingText(a: ActingIdentity): string {
  if (a.kind === 'acted') return a.login;
  if (a.kind === 'connected') return `${a.login} (your connected GitHub account; it has not acted for this job yet)`;
  return 'no GitHub account: Sources → Connect GitHub';
}
