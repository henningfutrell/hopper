// Job sources: where jobs come from, when each last synced, and what is wrong with it. The GitHub
// sources are one section (issue #160): the GitHub connection first (issue #214), with its source's
// sync inside it: the one way the hopper reads GitHub as the user (issue #359). Beside it, a GitHub App
// an admin set up, and why it is paused.
import { Inbox } from 'lucide-react';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { sourcesView, type GitHubConnection, type SourceUse } from '@/model/sources';
import type { SourceStatus } from '@/model/wire';
import { useHopper } from '@/store';
import { ConnectedAccountPanel } from './connected-account';
import { SourceSync } from './source-sync';

const USE: Record<SourceUse, { label: string; tone: 'ok' | 'warn' | 'muted' }> = {
  'in-use': { label: 'in use', tone: 'ok' }, paused: { label: 'paused', tone: 'warn' }, disabled: { label: 'disabled', tone: 'muted' },
};

function SourceCard({ s, c }: { s: SourceStatus; c?: GitHubConnection }) {
  // A GitHub connection shows its use; its state only when that adds something (error, starting).
  const badges = c
    ? <><StatusBadge status={c.use} label={USE[c.use].label} tone={USE[c.use].tone} />{(s.state === 'error' || s.state === 'starting') && <StatusBadge status={s.state} />}</>
    : <StatusBadge status={s.state} tone={s.state === 'ok' ? 'ok' : undefined} />;
  return (
    <Panel title={s.name} icon={Inbox} action={badges} className={c && c.use !== 'in-use' ? 'opacity-80' : undefined} bodyClassName="space-y-3">
      {c && <div data-source-use={c.use} className="text-xs">through the GitHub App, as its bot{c.why && <span className="text-muted-foreground"> · not in use: {c.why}</span>}</div>}
      <SourceSync s={s} />
    </Panel>
  );
}

export function Sources() {
  const sources = useHopper((s) => s.sources);
  const v = sourcesView(sources);
  return (
    <div className="space-y-4">
      <section className="space-y-2" aria-labelledby="sources-github">
        <div>
          <h2 id="sources-github" className="text-sm font-semibold">GitHub</h2>
          <p data-github-summary className="text-xs text-muted-foreground">{v.summary}</p>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          <ConnectedAccountPanel provider="github" source={v.account} />
          {v.github.map((c) => <SourceCard key={c.source.name} s={c.source} c={c} />)}
        </div>
      </section>
      {v.others.length > 0 && (
        <section className="grid gap-3 lg:grid-cols-2">{v.others.map((s) => <SourceCard key={s.name} s={s} />)}</section>
      )}
      {!sources.length && <Panel title="Sources" icon={Inbox}><Empty>no job sources configured</Empty></Panel>}
    </div>
  );
}
