// The Plugin store card (design.md "Plugin store"): the plugin store setting (issue #445: the default
// plugin store, a git repository an admin names here, or none), its commit and last read, Refresh;
// per plugin its role, description and Install, Update or Remove (confirmed). Installing does not
// configure: the plugin then shows under its role. Reads GET /api/plugin-store; an admin acts.
import { Download, RefreshCw, Store } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Confirm } from '@/components/confirm';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { get, post, SessionRejected } from '@/lib/api';
import { storeEntryView, storeSourceLabel } from '@/model/plugin-store';
import { ROLE_TITLES } from '@/model/plugins';
import type { PluginStoreEdit, PluginStoreEntry, PluginStoreReport } from '@/model/wire';
import { refreshPlugins, useHopper } from '@/store';
import { useCanAdminInstance } from '@/store/selectors';

type Act = (edit: PluginStoreEdit, done: string) => void;

function Entry({ e, busy, act, installable }: { e: PluginStoreEntry; busy: boolean; act: Act; installable: boolean }) {
  const authed = useCanAdminInstance();
  const v = storeEntryView(e, installable);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm">
      <span className="font-mono">{e.id}</span>
      <span className="text-xs text-muted-foreground">{ROLE_TITLES[e.role]}</span>
      <StatusBadge status={v.label} tone={v.tone} />
      <span className="basis-full text-xs break-words text-muted-foreground sm:basis-auto">{e.describe}</span>
      {authed && (
        <div className="ml-auto flex gap-2">
          {v.install && <Button size="sm" variant="outline" disabled={busy} onClick={() => act({ action: 'install', id: e.id }, `${e.id}: ${v.install === 'Install' ? 'installed' : 'updated'}`)}><Download />{v.install}</Button>}
          {v.removable && (
            <Confirm title={`Remove ${e.id}?`} action="Remove" description={`${e.id} leaves the plugin dir. It is refused while a plugin instance uses it.`}
              onConfirm={() => act({ action: 'remove', id: e.id }, `${e.id}: removed`)}>
              <Button size="sm" variant="ghost" className="text-bad" disabled={busy}>Remove</Button>
            </Confirm>
          )}
        </div>
      )}
    </div>
  );
}

/** Where the plugin store is: the setting, and for an admin the field to set, reset or clear it. */
function Source({ report, busy, act }: { report: PluginStoreReport; busy: boolean; act: Act }) {
  const authed = useCanAdminInstance();
  const [repo, setRepo] = useState(report.source === 'repo' ? report.repo ?? '' : '');
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (repo.trim()) act({ action: 'source', source: { kind: 'repo', repo: repo.trim() } }, 'Plugin store set');
  };
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        {report.repo && <code className="font-mono break-all">{report.repo}</code>}
        {report.commit && !report.from && <span className="font-mono text-muted-foreground">{report.commit.slice(0, 7)}</span>}
        {report.checkedAt && !report.from && <span className="text-muted-foreground">read {new Date(report.checkedAt).toLocaleTimeString()}</span>}
        {report.state !== 'unavailable' && <span className="text-muted-foreground">{storeSourceLabel(report)}</span>}
      </div>
      {authed
        ? (
          <form className="flex flex-wrap items-center gap-2" onSubmit={save}>
            <Input aria-label="Plugin store" spellCheck={false} className="h-7 min-w-0 flex-1 basis-60 font-mono text-xs" value={repo} onChange={(e) => setRepo(e.target.value)}
              placeholder={report.defaultRepo ?? 'a git repository (URL or path) holding plugin-store.yaml'} />
            <Button size="sm" type="submit" disabled={busy || !repo.trim()}>Save</Button>
            {report.source !== 'default' && report.defaultRepo && (
              <Button size="sm" variant="outline" type="button" disabled={busy} onClick={() => act({ action: 'source', source: { kind: 'default' } }, 'Default plugin store set')}>Use the default</Button>
            )}
            {report.source !== 'none' && (
              <Confirm title="Set no plugin store?" action="Set none" description="Nothing can be installed until a plugin store is set again. Store installs stay, and can still be removed."
                onConfirm={() => act({ action: 'source', source: { kind: 'none' } }, 'No plugin store set')}>
                <Button size="sm" variant="ghost" type="button" disabled={busy}>None</Button>
              </Confirm>
            )}
          </form>
        )
        : report.state === 'unavailable' && <div className="text-muted-foreground">An admin of this hopper sets the plugin store here.</div>}
    </div>
  );
}

export function PluginStore() {
  const authed = useCanAdminInstance();
  const [report, setReport] = useState<PluginStoreReport | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { get<PluginStoreReport>('/api/plugin-store').then(setReport, (e: Error) => toast.error(e.message)); }, []);

  const act = (edit: PluginStoreEdit, done: string) => {
    setBusy(true);
    post<PluginStoreReport>('/ui/api/plugin-store', edit)
      .then((r) => { setReport(r); toast.success(done); return refreshPlugins(); })
      .catch((e: Error) => { if (e instanceof SessionRejected) useHopper.setState({ authed: false }); toast.error(e.message); })
      .finally(() => setBusy(false));
  };

  if (!report) return <Panel title="Plugin store" icon={Store}><Empty>loading…</Empty></Panel>;
  return (
    <Panel title="Plugin store" icon={Store} count={report.plugins.length || ''} bodyClassName="space-y-2 text-xs"
      action={authed && report.repo && <Button size="sm" variant="outline" disabled={busy} onClick={() => act({ action: 'refresh' }, 'Plugin store read')}><RefreshCw />Refresh</Button>}>
      {/* Keyed by the setting: a new setting starts the field over. */}
      <Source key={`${report.source}:${report.repo ?? ''}`} report={report} busy={busy} act={act} />
      {report.state === 'unavailable' && <div className="text-muted-foreground">{report.reason}{authed ? ': name a git repository holding plugin-store.yaml above.' : '.'}</div>}
      {report.error && <div className="text-bad">{report.error}</div>}
      {report.from && <div className="text-muted-foreground">The plugins below were read from <code className="font-mono break-all">{report.from}</code>; nothing installs from them until the plugin store is read.</div>}
      {report.plugins.length
        ? report.plugins.map((e) => <Entry key={e.id} e={e} busy={busy} act={act} installable={report.state !== 'unavailable' && !report.from} />)
        : report.state !== 'unavailable' && <Empty>{report.commit ? 'the store catalogue lists no plugins' : report.error ? 'no catalogue read yet' : 'reading…'}</Empty>}
    </Panel>
  );
}
