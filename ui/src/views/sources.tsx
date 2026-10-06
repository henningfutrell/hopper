// Job sources: where jobs come from, when each last synced, and what is wrong with it. The GitHub
// sources are one section (issue #160): which connection reads issues, why the other is paused, and
// gh login beside them.
import { Inbox } from 'lucide-react';
import { Countdown, GhLink } from '@/components/job';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { useNow } from '@/hooks/use-now';
import { ago } from '@/model/format';
import { sourcesView, type GitHubConnection, type SourceUse } from '@/model/sources';
import type { SourceStatus } from '@/model/wire';
import { useHopper } from '@/store';
import { GhLoginPanel } from './gh-login';

const list = (v: unknown) => (Array.isArray(v) ? v.join(', ') : String(v));
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const empty = (v: unknown) => v == null || v === 0 || (typeof v === 'object' && Object.keys(v as object).length === 0);

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return <div><div className="text-[11px] text-muted-foreground">{label}</div><div className="num text-lg font-semibold">{value}</div></div>;
}

const USE: Record<SourceUse, { label: string; tone: 'ok' | 'warn' | 'muted' }> = {
  'in-use': { label: 'in use', tone: 'ok' }, paused: { label: 'paused', tone: 'warn' }, disabled: { label: 'disabled', tone: 'muted' },
};
const VIA_LABEL: Record<GitHubConnection['via'], string> = { gh: 'through gh, as the logged-in GitHub user', app: 'through the GitHub App, as its bot' };

function SourceCard({ s, c }: { s: SourceStatus; c?: GitHubConnection }) {
  const now = useNow();
  const d = s.detail ?? {};
  const repos = Array.isArray(d.installedRepos) ? (d.installedRepos as string[]) : [];
  // A GitHub connection shows its use; its state only when that adds something (error, starting).
  const badges = c
    ? <><StatusBadge status={c.use} label={USE[c.use].label} tone={USE[c.use].tone} />{(s.state === 'error' || s.state === 'starting') && <StatusBadge status={s.state} />}</>
    : <StatusBadge status={s.state} tone={s.state === 'ok' ? 'ok' : undefined} />;
  return (
    <Panel title={s.name} icon={Inbox} action={badges} className={c && c.use !== 'in-use' ? 'opacity-80' : undefined} bodyClassName="space-y-3">
      {c && <div data-source-use={c.use} className="text-xs">{VIA_LABEL[c.via]}{c.why && <span className="text-muted-foreground"> · not in use: {c.why}</span>}</div>}
      <div className="grid grid-cols-3 gap-3">
        <Stat label="seen" value={s.itemsSeen} /><Stat label="created" value={s.jobsCreated} /><Stat label="active" value={s.activeJobs} />
      </div>
      <div className="num text-xs text-muted-foreground">
        <span className="font-mono">{s.kind}</span> · last sync <span title={s.lastSyncAt}>{ago(s.lastSyncAt, now)}</span>
        {s.nextSyncAt && <> · next <Countdown iso={s.nextSyncAt} /></>}
      </div>
      {s.lastError && <div className="rounded-md border border-bad/30 bg-bad/5 p-2 text-xs break-words text-bad">{s.lastError}</div>}
      {str(d.setup) && <div className="rounded-md border border-warn/30 bg-warn/5 p-2 text-xs">Setup needed: <code className="font-mono">{String(d.setup)}</code></div>}
      {str(d.appError) && <div className="text-xs text-bad">app error: {String(d.appError)}</div>}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {str(d.slug) && <GhLink url={str(d.htmlUrl)}>app {String(d.slug)}</GhLink>}
        {str(d.installUrl) && <GhLink url={str(d.installUrl)}>install / add repos</GhLink>}
        {str(d.configUrl) && <GhLink url={str(d.configUrl)}>configure</GhLink>}
      </div>
      {repos.length > 0 && <div className="flex flex-wrap gap-1">{repos.map((r) => <span key={r} className="rounded border px-1.5 font-mono text-[11px] text-muted-foreground">{r}</span>)}</div>}
      <div className="space-y-0.5 text-xs text-muted-foreground">
        {['owners', 'repos', 'authors', 'label'].filter((k) => d[k] != null && list(d[k]) !== '').map((k) => <div key={k}>{k}: <span className="text-foreground/80">{list(d[k])}</span></div>)}
        {['projectErrors', 'permanentErrors'].filter((k) => !empty(d[k])).map((k) => <div key={k} className="text-bad">{k}: {typeof d[k] === 'object' ? JSON.stringify(d[k]) : String(d[k])}</div>)}
        {Array.isArray(d.notRerun) && d.notRerun.map((n: { key: string; job: string; status: string; reason: string }) => <div key={n.key} data-not-rerun className="text-warn">not run again: <GhLink url={n.key}>{n.key}</GhLink> (job {n.status}, {n.reason})</div>)}
        {d.enabledSetting != null && <div>enabled setting: <code>{String(d.enabledSetting)}</code></div>}
      </div>
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
          <p data-github-summary className="text-xs text-muted-foreground">{v.summary} gh login is separate: it is who jobs push as, whichever connection reads issues.</p>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          {v.github.map((c) => <SourceCard key={c.source.name} s={c.source} c={c} />)}
          <GhLoginPanel />
        </div>
      </section>
      {v.others.length > 0 && (
        <section className="grid gap-3 lg:grid-cols-2">{v.others.map((s) => <SourceCard key={s.name} s={s} />)}</section>
      )}
      {!sources.length && <Panel title="Sources" icon={Inbox}><Empty>no job sources configured</Empty></Panel>}
    </div>
  );
}
