// The Sources view's GitHub section (issues #160, #214, #254, #359): the connected GitHub account is how
// the hopper reads GitHub as the user, and the GitHub App an admin set up (github-app) is the one other
// connection. The connected account's source is the GitHub connection itself — the panel shows it,
// never a card beside it. Which one reads issues, why the other is paused or disabled, and one sentence
// that says how they relate. A source on but not configured (issue #1243) needs setup and says what it lacks.
// Pure; the view renders it.
import type { SourceStatus } from './wire.ts';

export type SourceUse = 'in-use' | 'needs-setup' | 'paused' | 'disabled';
export interface GitHubConnection { source: SourceStatus; use: SourceUse; why?: string }
export interface SourcesView {
  /** The connected account's source (`github-account`), shown in the GitHub connection panel. */
  account?: SourceStatus;
  /** GitHub is connected and its source reads issues. */
  connected: boolean;
  /** The GitHub App sources still shown, in use first. */
  github: GitHubConnection[];
  summary: string;
  others: SourceStatus[];
  /** The sources that take the same work as an earlier one (issue #1264), each to remove. */
  duplicates: SourceStatus[];
}

const ACCOUNT = 'github-account';
const APP = 'github-app';
const ORDER: Record<SourceUse, number> = { 'in-use': 0, 'needs-setup': 1, paused: 2, disabled: 3 };

// Paused before disabled: the sync loop reports a paused source with no active jobs as state
// `disabled` (src/sources/sync.ts), yet it is paused, not switched off.
function connection(source: SourceStatus): GitHubConnection {
  if (source.setupProblem) return { source, use: 'needs-setup', why: source.setupProblem.reason };
  const paused = source.detail.paused;
  if (typeof paused === 'string') return { source, use: 'paused', why: paused };
  if (source.state === 'disabled') return { source, use: 'disabled', why: 'switched off in its settings' };
  return { source, use: 'in-use' };
}

const isConnected = (s: SourceStatus | undefined) => s !== undefined && typeof s.detail.paused !== 'string' && s.state !== 'disabled';

function summary(account: SourceStatus | undefined, connected: boolean, github: GitHubConnection[]): string {
  const app = github.some((c) => c.use === 'in-use');
  if (connected) {
    const who = typeof account!.detail.login === 'string' ? `, ${account!.detail.login}` : '';
    return `Issues are read, and jobs work, through your GitHub connection${who}.${app ? ' The GitHub App an admin set up also reads issues, as its bot.' : ''}`;
  }
  if (app) return `Issues are read through the GitHub App, as its bot.${account ? ' Connect GitHub to read your own issues too.' : ''}`;
  if (account) return typeof account.detail.paused === 'string' ? `No issue is read through your GitHub connection: ${account.detail.paused}.` : 'No issue is read through your GitHub connection.';
  return 'No GitHub connection is configured.';
}

export function sourcesView(sources: SourceStatus[]): SourcesView {
  // A second connected-account source (issue #1264) is a card of its own beside the app's, marked as the duplicate it is.
  const account = sources.find((s) => s.kind === ACCOUNT && !s.duplicateOf) ?? sources.find((s) => s.kind === ACCOUNT);
  const connected = isConnected(account);
  const github = sources
    .filter((s) => s.kind === APP || (s.kind === ACCOUNT && s !== account))
    .map(connection)
    .sort((a, b) => ORDER[a.use] - ORDER[b.use]);
  return {
    ...(account ? { account } : {}), connected, github, summary: summary(account, connected, github),
    others: sources.filter((s) => s.kind !== ACCOUNT && s.kind !== APP),
    duplicates: sources.filter((s) => s.duplicateOf !== undefined),
  };
}

/** The sources on but not configured (issue #1243), one line each: its name and what it lacks. */
export const notConfiguredLines = (sources: readonly SourceStatus[]): string[] =>
  sources.flatMap((s) => (s.setupProblem ? [`${s.name}: ${s.setupProblem.reason}`] : []));

/**
 * Why the GitHub connection ended (issue #441), while it has — its sign-in expired or its stored token
 * cannot be read — for the header to ask to connect again on every screen. Undefined while it lives, or
 * was never connected.
 */
export function connectionEnded(sources: SourceStatus[]): string | undefined {
  const account = sources.find((s) => s.kind === ACCOUNT);
  return account?.detail.expired === true && typeof account.detail.paused === 'string' ? account.detail.paused : undefined;
}
