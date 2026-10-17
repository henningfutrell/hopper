// The GitHub identity that acts for a job (issue #1380), pure: the hopper acts for a job with its own user's GitHub
// connection, and each GitHub request and push of the job names the login that acted (`as`). Before the job acted, its
// user's connected GitHub account is the one that will act: the account whose job repositories hold the job's repository
// (issue #1448), else the first. A GitLab job (issue #1448 part 3): its pushes name the GitLab username that acted, and before
// it acted its user's GitLab account is the one that will act.
import type { ConnectedAccountStatus, DomainEvent, GitLabAccountStatus } from './wire.ts';

export type ActingIdentity = { kind: 'acted' | 'connected'; login: string } | { kind: 'none' };

const PROXY = new Set(['github_proxy.done', 'github_proxy.refused', 'github_proxy.failed']);
const GITLAB_PROXY = new Set(['gitlab_proxy.done', 'gitlab_proxy.refused', 'gitlab_proxy.failed']);

/** The forge a job acts on: GitLab for a job of the GitLab source (issue #1448 part 3), else GitHub. */
export type Forge = 'GitHub' | 'GitLab';
export const forgeOf = (source: { kind: string } | undefined): Forge => (source?.kind === 'gitlab-account' ? 'GitLab' : 'GitHub');

/** The newest login a proxy event of `types` names (`as`). */
const actedAs = (events: readonly DomainEvent[], types: ReadonlySet<string>): string | undefined => {
  for (const e of events) {
    const as = types.has(e.type) ? (e.data as { as?: unknown }).as : undefined;
    if (typeof as === 'string') return as;
  }
  return undefined;
};

/** From the job's events, newest first, and its user's GitHub account as /api/connected-accounts reports it. */
export function actingIdentity(events: readonly DomainEvent[], account: ConnectedAccountStatus | undefined): ActingIdentity {
  const as = actedAs(events, PROXY);
  if (as !== undefined) return { kind: 'acted', login: as };
  return account?.state === 'connected' ? { kind: 'connected', login: account.account } : { kind: 'none' };
}

/** A GitLab job's (issue #1448 part 3): from its events, newest first, and its user's GitLab account as /api/gitlab-account reports it. */
export function gitlabActingIdentity(events: readonly DomainEvent[], account: GitLabAccountStatus | undefined): ActingIdentity {
  const as = actedAs(events, GITLAB_PROXY);
  if (as !== undefined) return { kind: 'acted', login: as };
  return account?.state === 'connected' ? { kind: 'connected', login: account.account } : { kind: 'none' };
}

/** The account that acts for a job of `repo` (issue #1448): the one whose job repositories hold it (any case), else the first. */
export function accountFor(accounts: readonly ConnectedAccountStatus[], repo: string | undefined): ConnectedAccountStatus | undefined {
  const r = repo?.toLowerCase();
  const chosen = r === undefined ? undefined : accounts.find((a) => a.state === 'connected' && a.jobRepositories.some((x) => x.toLowerCase() === r));
  return chosen ?? accounts.find((a) => a.key === a.provider) ?? accounts[0];
}

export function actingText(a: ActingIdentity, forge: Forge = 'GitHub'): string {
  if (a.kind === 'acted') return a.login;
  if (a.kind === 'connected') return `${a.login} (your connected ${forge} account; it has not acted for this job yet)`;
  return `no ${forge} account: Sources → Connect ${forge}`;
}
