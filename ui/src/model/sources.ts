// The Sources view's GitHub section (issue #160): the github-gh and github-app sources are two
// connections to one GitHub. Which one reads issues, why the other is paused or disabled, and one
// sentence that says how they relate. Pure; the view renders it.
import type { SourceStatus } from './wire.ts';

export type SourceUse = 'in-use' | 'paused' | 'disabled';
export interface GitHubConnection { source: SourceStatus; via: 'gh' | 'app'; use: SourceUse; why?: string }
export interface SourcesView { github: GitHubConnection[]; summary: string; others: SourceStatus[] }

const VIA: Record<string, GitHubConnection['via']> = { github: 'gh', 'github-app': 'app' };
const ORDER: Record<SourceUse, number> = { 'in-use': 0, paused: 1, disabled: 2 };

// Paused before disabled: the sync loop reports a paused source with no active jobs as state
// `disabled` (src/sources/sync.ts), yet it is paused, not switched off.
function connection(source: SourceStatus, via: GitHubConnection['via']): GitHubConnection {
  const paused = source.detail.paused;
  // gh pauses for one reason only (src/sources/compose.ts GH_PAUSED); the app names its own.
  if (typeof paused === 'string') return { source, via, use: 'paused', why: via === 'gh' ? 'the GitHub App is set up, so issues are read through it instead' : paused };
  if (source.state === 'disabled') return { source, via, use: 'disabled', why: 'switched off in its settings' };
  return { source, via, use: 'in-use' };
}

function summary(github: GitHubConnection[]): string {
  if (!github.length) return 'No GitHub connection is configured.';
  const using = (via: GitHubConnection['via']) => github.some((c) => c.via === via && c.use === 'in-use');
  const paused = (via: GitHubConnection['via']) => github.some((c) => c.via === via && c.use === 'paused');
  if (using('gh') && using('app')) return 'Issues are read through both gh and the GitHub App.';
  if (using('app')) return `Issues are read through the GitHub App, as its bot.${paused('gh') ? ' gh is paused while the GitHub App is set up.' : ''}`;
  if (using('gh')) return `Issues are read through gh, as the logged-in GitHub user.${paused('app') ? ' The GitHub App takes over once it is set up.' : ''}`;
  return 'No GitHub connection is reading issues.';
}

export function sourcesView(sources: SourceStatus[]): SourcesView {
  const github = sources.flatMap((s) => (VIA[s.kind] ? [connection(s, VIA[s.kind]!)] : []))
    .sort((a, b) => ORDER[a.use] - ORDER[b.use]);
  return { github, summary: summary(github), others: sources.filter((s) => !VIA[s.kind]) };
}
