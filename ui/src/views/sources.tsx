// Job sources: where jobs come from, when each last synced, and what is wrong with it. The GitHub
// sources are one section (issue #160): the GitHub connection first (issue #214), with its source's
// sync inside it: the one way the hopper reads GitHub as the user (issue #359). Beside it, a GitHub App
// an admin set up, and why it is paused, or what it lacks while it is on but not configured (issue #1243). Below it, each job repository's setup (issue #652).
// A source that takes the same work as an earlier one (issue #1264) is named in a banner at the top, with one click to remove it.
import { useState } from 'react';
import { CopyX, Inbox, Trash2 } from 'lucide-react';
import { sendPluginsEdit } from '@/components/plugin-form';
import { Button } from '@/components/ui/button';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { sourcesView, type GitHubConnection, type SourceUse } from '@/model/sources';
import type { SourceStatus } from '@/model/wire';
import { refreshPlugins, useHopper } from '@/store';
import { AfterAnswer } from './after-answer';
import { ConnectedAccountPanel } from './connected-account';
import { RepoSetupSection } from './repo-setup';
import { SourceSync } from './source-sync';

const USE: Record<SourceUse, { label: string; tone: 'ok' | 'warn' | 'muted' }> = {
  'in-use': { label: 'in use', tone: 'ok' }, 'needs-setup': { label: 'needs setup', tone: 'warn' }, paused: { label: 'paused', tone: 'warn' }, disabled: { label: 'disabled', tone: 'muted' },
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

/** Removes a duplicate source from the plugins config, at the version read just now. */
async function removeDuplicate(name: string): Promise<void> {
  await refreshPlugins();
  const version = useHopper.getState().plugins?.config.version;
  if (version) await sendPluginsEdit({ action: 'remove', role: 'job-source', name, version }, `Removed ${name}`);
}

/** The duplicate sources (issue #1264): each polls the same service again for the same work, so each has a Remove. */
function DuplicateBanner({ duplicates }: { duplicates: SourceStatus[] }) {
  const [busy, setBusy] = useState<string>();
  if (!duplicates.length) return null;
  return (
    <div data-duplicate-sources role="alert" className="space-y-1.5 rounded-md border border-bad/40 bg-bad/5 p-3 text-xs">
      <div className="flex items-center gap-1.5 font-medium text-bad"><CopyX className="size-4" />
        {duplicates.length === 1 ? 'A job source is a duplicate' : `${duplicates.length} job sources are duplicates`}: each polls GitHub again for the same issues. Remove it.</div>
      {duplicates.map((d) => (
        <div key={d.name} className="flex flex-wrap items-center gap-2">
          <span><span className="font-mono">{d.name}</span> takes the same work as <span className="font-mono">{d.duplicateOf}</span></span>
          <Button size="xs" variant="outline" data-remove-duplicate={d.name} disabled={busy !== undefined}
            onClick={() => { setBusy(d.name); void removeDuplicate(d.name).finally(() => setBusy(undefined)); }}><Trash2 />Remove {d.name}</Button>
        </div>
      ))}
    </div>
  );
}

export function Sources() {
  const sources = useHopper((s) => s.sources);
  const v = sourcesView(sources);
  return (
    <div className="space-y-4">
      <DuplicateBanner duplicates={v.duplicates} />
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
      <RepoSetupSection />
      {v.others.length > 0 && (
        <section className="grid gap-3 lg:grid-cols-2">{v.others.map((s) => <SourceCard key={s.name} s={s} />)}</section>
      )}
      <AfterAnswer />
      {!sources.length && <Panel title="Sources" icon={Inbox}><Empty>no job sources configured</Empty></Panel>}
    </div>
  );
}
