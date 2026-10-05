// Job sources: where jobs come from, when each last synced, and what is wrong with it.
import { Inbox } from 'lucide-react';
import { Countdown, GhLink } from '@/components/job';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { useNow } from '@/hooks/use-now';
import { ago } from '@/model/format';
import type { SourceStatus } from '@/model/wire';
import { useHopper } from '@/store';
import { GhLoginPanel } from './gh-login';

const list = (v: unknown) => (Array.isArray(v) ? v.join(', ') : String(v));
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const empty = (v: unknown) => v == null || v === 0 || (typeof v === 'object' && Object.keys(v as object).length === 0);

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return <div><div className="text-[11px] text-muted-foreground">{label}</div><div className="num text-lg font-semibold">{value}</div></div>;
}

function SourceCard({ s }: { s: SourceStatus }) {
  const now = useNow();
  const d = s.detail ?? {};
  const repos = Array.isArray(d.installedRepos) ? (d.installedRepos as string[]) : [];
  return (
    <Panel title={s.name} icon={Inbox} action={<>{str(d.mode) && <StatusBadge status={String(d.mode)} />}<StatusBadge status={s.state} tone={s.state === 'ok' ? 'ok' : undefined} /></>} bodyClassName="space-y-3">
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
        {str(d.paused) && <div>paused: {String(d.paused)}</div>}
        {d.enabledSetting != null && <div>enabled: <code>{String(d.enabledSetting)}</code></div>}
      </div>
    </Panel>
  );
}

export function Sources() {
  const sources = useHopper((s) => s.sources);
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <GhLoginPanel />
      {sources.length
        ? sources.map((s) => <SourceCard key={s.name} s={s} />)
        : <Panel title="Sources" icon={Inbox}><Empty>no job sources configured</Empty></Panel>}
    </div>
  );
}
