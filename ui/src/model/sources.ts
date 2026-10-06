// The Sources view's GitHub section (issues #160, #214): the connected GitHub account, the
// github-gh and the github-app sources are three ways to one GitHub. Which one reads issues, why the
// others are paused or disabled, and one sentence that says how they relate. Pure; the view renders it.
import type { SourceStatus } from './wire.ts';

export type SourceUse = 'in-use' | 'paused' | 'disabled';
export type Via = 'account' | 'gh' | 'app';
export interface GitHubConnection { source: SourceStatus; via: Via; use: SourceUse; why?: string }
export interface SourcesView { github: GitHubConnection[]; summary: string; others: SourceStatus[] }

const GITHUB: Record<string, Via> = { 'github-account': 'account', github: 'gh', 'github-app': 'app' };
const ORDER: Record<SourceUse, number> = { 'in-use': 0, paused: 1, disabled: 2 };
const VIA_ORDER: Record<Via, number> = { account: 0, gh: 1, app: 2 };
/** gh's pause reasons (src/sources/compose.ts GH_PAUSED_ACCOUNT, GH_PAUSED), in plain words. */
const GH_WHY: Record<string, string> = {
  'GitHub account connected': 'a GitHub account is connected, so issues are read through it instead',
  'GitHub App configured': 'the GitHub App is set up, so issues are read through it instead',
};

// Paused before disabled: the sync loop reports a paused source with no active jobs as state
// `disabled` (src/sources/sync.ts), yet it is paused, not switched off.
function connection(source: SourceStatus, via: Via, provider: string): GitHubConnection {
  const paused = source.detail.paused;
  if (typeof paused === 'string') {
    const why = via === 'gh' ? GH_WHY[paused] ?? paused : via === 'account' ? `not connected: Connect ${provider} above` : paused;
    return { source, via, use: 'paused', why };
  }
  if (source.state === 'disabled') return { source, via, use: 'disabled', why: 'switched off in its settings' };
  return { source, via, use: 'in-use' };
}

const login = (c: GitHubConnection | undefined) => (typeof c?.source.detail.login === 'string' ? c.source.detail.login : undefined);

function summary(github: GitHubConnection[]): string {
  if (!github.length) return 'No GitHub connection is configured.';
  const find = (via: Via, use: SourceUse) => github.find((c) => c.via === via && c.use === use);
  const using = (via: Via) => find(via, 'in-use') !== undefined;
  const paused = (via: Via) => find(via, 'paused') !== undefined;
  if (using('account')) {
    const who = login(find('account', 'in-use'));
    return `Issues are read through the connected GitHub account${who ? `, ${who}` : ''}.${paused('gh') ? ' gh is paused while it is connected.' : ''}`;
  }
  if (using('gh') && using('app')) return 'Issues are read through both gh and the GitHub App.';
  if (using('app')) return `Issues are read through the GitHub App, as its bot.${paused('gh') ? ' gh is paused while the GitHub App is set up.' : ''}`;
  if (using('gh')) {
    const next = paused('account') ? ' Connect a GitHub account to read its issues instead.' : paused('app') ? ' The GitHub App takes over once it is set up.' : '';
    return `Issues are read through gh, as the logged-in GitHub user.${next}`;
  }
  return paused('account') ? 'No GitHub connection is reading issues: connect GitHub above.' : 'No GitHub connection is reading issues.';
}

const section = (sources: SourceStatus[], vias: Record<string, Via>, provider: string) => sources
  .flatMap((s) => (vias[s.kind] ? [connection(s, vias[s.kind]!, provider)] : []))
  .sort((a, b) => ORDER[a.use] - ORDER[b.use] || VIA_ORDER[a.via] - VIA_ORDER[b.via]);

export function sourcesView(sources: SourceStatus[]): SourcesView {
  const github = section(sources, GITHUB, 'GitHub');
  return { github, summary: summary(github), others: sources.filter((s) => !GITHUB[s.kind]) };
}
