// Repository setup (issue #652, design.md "Repository setup"), pure: the line Sources shows over each job repository's
// setup. The daemon reads GitHub and says what is missing; the UI only says it.
import type { RepoChecks } from './wire.ts';

/** The repositories not set up, then those whose setup is not known; '' with none read. */
export function setupLine(repos: Pick<RepoChecks, 'repo' | 'setup'>[]): string {
  const named = (state: RepoChecks['setup']['state']) => repos.filter((r) => r.setup?.state === state).map((r) => r.repo);
  const not = named('not set up');
  const unknown = named('unknown');
  if (not.length === 0 && unknown.length === 0) return repos.length > 0 ? 'Every job repository is set up.' : '';
  return [not.length > 0 ? `Not set up: ${not.join(', ')}.` : '', unknown.length > 0 ? `Not known: ${unknown.join(', ')}.` : ''].filter(Boolean).join(' ');
}

/** What the setup asks, for the panel's note. */
export const SETUP_ASKS = 'The default branch and each release branch (dev, beta, stable, main, master) need a pull request and a status check, and take no force push. Secret scanning and push protection are on.';
/** Why part of the setup can be unread. */
export const UNREAD_WHY = 'It shows branch protection and the security settings only to a repository admin.';
