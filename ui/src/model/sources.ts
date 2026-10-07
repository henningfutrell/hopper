// The Sources view's GitHub section (issues #160, #214, #254): the connected GitHub account, the
// github-gh and the github-app sources are three ways to one GitHub. The connected account's source is
// the GitHub connection itself — the panel shows it, never a card beside it. Once GitHub is connected,
// that connection is the one piece: gh and gh login are not shown, and the app-as-itself source shows
// only where an admin set one up. Which one reads issues, why the others are paused or disabled, and
// one sentence that says how they relate. Pure; the view renders it.
import type { SourceStatus } from './wire.ts';

export type SourceUse = 'in-use' | 'paused' | 'disabled';
export type Via = 'gh' | 'app';
export interface GitHubConnection { source: SourceStatus; via: Via; use: SourceUse; why?: string }
export interface SourcesView {
  /** The connected account's source (`github-account`), shown in the GitHub connection panel. */
  account?: SourceStatus;
  /** GitHub is connected and its source reads issues: it is the one GitHub piece. */
  connected: boolean;
  /** The other GitHub sources still shown, in use first. */
  github: GitHubConnection[];
  /** gh login is shown only while no GitHub account is connected. */
  ghLogin: boolean;
  summary: string;
  others: SourceStatus[];
}

const ACCOUNT = 'github-account';
// A source that cannot run (unknown plugin, invalid options) is reported under its plugin's id
// (src/users/runtime.ts splitSources): gh's is `github-gh`. It is gh all the same (issue #320).
const GITHUB: Record<string, Via> = { github: 'gh', 'github-gh': 'gh', 'github-app': 'app' };
const ORDER: Record<SourceUse, number> = { 'in-use': 0, paused: 1, disabled: 2 };
const VIA_ORDER: Record<Via, number> = { gh: 0, app: 1 };
/** The app source's pause while no app is set up (src/sources/compose.ts APP_MISSING): then it is not shown. */
const APP_MISSING = 'no GitHub App configured';
/** gh's pause reasons (src/sources/compose.ts GH_PAUSED_ACCOUNT, GH_PAUSED), in plain words. */
const GH_WHY: Record<string, string> = {
  'GitHub account connected': 'a GitHub account is connected, so issues are read through it instead',
  'GitHub App configured': 'the GitHub App is set up, so issues are read through it instead',
};

// Paused before disabled: the sync loop reports a paused source with no active jobs as state
// `disabled` (src/sources/sync.ts), yet it is paused, not switched off.
function connection(source: SourceStatus, via: Via): GitHubConnection {
  const paused = source.detail.paused;
  if (typeof paused === 'string') return { source, via, use: 'paused', why: via === 'gh' ? GH_WHY[paused] ?? paused : paused };
  if (source.state === 'disabled') return { source, via, use: 'disabled', why: 'switched off in its settings' };
  return { source, via, use: 'in-use' };
}

const isConnected = (s: SourceStatus | undefined) => s !== undefined && typeof s.detail.paused !== 'string' && s.state !== 'disabled';

function summary(account: SourceStatus | undefined, connected: boolean, github: GitHubConnection[]): string {
  const using = (via: Via) => github.some((c) => c.via === via && c.use === 'in-use');
  const paused = (via: Via) => github.some((c) => c.via === via && c.use === 'paused');
  if (connected) {
    const who = typeof account!.detail.login === 'string' ? `, ${account!.detail.login}` : '';
    return `Issues are read, and jobs work, through your GitHub connection${who}.${using('app') ? ' The GitHub App an admin set up also reads issues, as its bot.' : ''}`;
  }
  if (!account && !github.length) return 'No GitHub connection is configured.';
  if (using('gh') && using('app')) return 'Issues are read through both gh and the GitHub App.';
  if (using('app')) return `Issues are read through the GitHub App, as its bot.${paused('gh') ? ' gh is paused while the GitHub App is set up.' : ''}`;
  if (using('gh')) return `Issues are read through gh, as the logged-in GitHub user.${account ? ' Connect GitHub to read its issues instead.' : ''}`;
  return account ? 'No GitHub connection is reading issues: connect GitHub above.' : 'No GitHub connection is reading issues.';
}

export function sourcesView(sources: SourceStatus[]): SourcesView {
  const account = sources.find((s) => s.kind === ACCOUNT);
  const connected = isConnected(account);
  const github = sources
    .flatMap((s) => (GITHUB[s.kind] ? [connection(s, GITHUB[s.kind]!)] : []))
    // An app source with no app set up is no connection; once GitHub is connected, gh is none either.
    .filter((c) => !(c.via === 'app' && c.source.detail.paused === APP_MISSING) && !(connected && c.via === 'gh'))
    .sort((a, b) => ORDER[a.use] - ORDER[b.use] || VIA_ORDER[a.via] - VIA_ORDER[b.via]);
  return {
    ...(account ? { account } : {}), connected, github, ghLogin: !connected, summary: summary(account, connected, github),
    others: sources.filter((s) => s.kind !== ACCOUNT && !GITHUB[s.kind]),
  };
}
