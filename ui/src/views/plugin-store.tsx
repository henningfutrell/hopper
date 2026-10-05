// The Plugin store card (design.md "Plugin store"): the store, its commit and last read, Refresh;
// per plugin its role, description and Install, Update or Remove (confirmed). Installing does not
// configure: the plugin then shows under its role. Reads GET /api/plugin-store; an admin acts.
import { Download, RefreshCw, Store } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Confirm } from '@/components/confirm';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { get, post, SessionRejected } from '@/lib/api';
import { storeEntryView } from '@/model/plugin-store';
import { ROLE_TITLES } from '@/model/plugins';
import type { PluginStoreEdit, PluginStoreEntry, PluginStoreReport } from '@/model/wire';
import { refreshPlugins, useHopper } from '@/store';
import { useCanAdmin } from '@/store/selectors';

function Entry({ e, busy, act }: { e: PluginStoreEntry; busy: boolean; act: (edit: PluginStoreEdit, done: string) => void }) {
  const authed = useCanAdmin();
  const v = storeEntryView(e);
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
            <Confirm title={`Remove ${e.id}?`} action="Remove" description={`${e.id} leaves the plugin dir. It is refused while plugins.yaml names it.`}
              onConfirm={() => act({ action: 'remove', id: e.id }, `${e.id}: removed`)}>
              <Button size="sm" variant="ghost" className="text-bad" disabled={busy}>Remove</Button>
            </Confirm>
          )}
        </div>
      )}
    </div>
  );
}

export function PluginStore() {
  const authed = useCanAdmin();
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
      action={authed && report.state !== 'unavailable' && <Button size="sm" variant="outline" disabled={busy} onClick={() => act({ action: 'refresh' }, 'Plugin store read')}><RefreshCw />Refresh</Button>}>
      {report.state === 'unavailable'
        ? <Empty>{report.reason}</Empty>
        : <>
          <div className="flex flex-wrap items-center gap-2">
            <code className="font-mono break-all">{report.repo}</code>
            {report.commit && <span className="font-mono text-muted-foreground">{report.commit.slice(0, 7)}</span>}
            {report.checkedAt && <span className="text-muted-foreground">read {new Date(report.checkedAt).toLocaleTimeString()}</span>}
          </div>
          {report.error && <div className="text-bad">{report.error}</div>}
          {report.plugins.length
            ? report.plugins.map((e) => <Entry key={e.id} e={e} busy={busy} act={act} />)
            : <Empty>{report.commit ? 'the store catalogue lists no plugins' : 'reading…'}</Empty>}
        </>}
    </Panel>
  );
}
