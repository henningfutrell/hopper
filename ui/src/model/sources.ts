// The Sources view's GitHub section (issues #160, #214, #254, #359): the connected GitHub account is how
// the hopper reads GitHub as the user, and the GitHub App an admin set up (github-app) is the one other
// connection. The connected account's source is the GitHub connection itself — the panel shows it,
// never a card beside it. Which one reads issues, why the other is paused or disabled, and one sentence
// that says how they relate. Pure; the view renders it.
import type { SourceStatus } from './wire.ts';

export type SourceUse = 'in-use' | 'paused' | 'disabled';
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
}

const ACCOUNT = 'github-account';
const APP = 'github-app';
const ORDER: Record<SourceUse, number> = { 'in-use': 0, paused: 1, disabled: 2 };
/** The app source's pause while no app is set up (src/sources/compose.ts APP_MISSING): then it is not shown. */
const APP_MISSING = 'no GitHub App configured';

// Paused before disabled: the sync loop reports a paused source with no active jobs as state
// `disabled` (src/sources/sync.ts), yet it is paused, not switched off.
function connection(source: SourceStatus): GitHubConnection {
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
  const account = sources.find((s) => s.kind === ACCOUNT);
  const connected = isConnected(account);
  const github = sources
    .filter((s) => s.kind === APP)
    .map(connection)
    // An app source with no app set up is no connection.
    .filter((c) => c.source.detail.paused !== APP_MISSING)
    .sort((a, b) => ORDER[a.use] - ORDER[b.use]);
  return {
    ...(account ? { account } : {}), connected, github, summary: summary(account, connected, github),
    others: sources.filter((s) => s.kind !== ACCOUNT && s.kind !== APP),
  };
}
