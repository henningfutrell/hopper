// Pick an installed GitHub App (issue #1243): on the GitHub App source's setup card, the apps already installed on the
// organizations the person's GitHub connection knows (GET /api/github-apps, read from GitHub on the ask). Use this app sets
// that app's id and slug on the source, as an edit of its options in the plugins config (POST /ui/api/plugins, an admin's);
// the source's other options stay as they are. An organization GitHub would not list is named, with why.
import { useState } from 'react';
import { toast } from 'sonner';
import { GhLink } from '@/components/job';
import { sendPluginsEdit } from '@/components/plugin-form';
import { Button } from '@/components/ui/button';
import { get } from '@/lib/api';
import type { InstalledApp, InstalledAppsView, PluginsReport } from '@/model/wire';
import { useCanAdmin } from '@/store/selectors';

/** GitHub is asked once for each organization: it may take a while. */
const LIST_TIMEOUT_MS = 60_000;

export function InstalledAppPicker({ source }: { source: string }) {
  const canAdmin = useCanAdmin();
  const [view, setView] = useState<InstalledAppsView | undefined>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | undefined>();
  const list = async () => {
    setBusy(true);
    setFailed(undefined);
    try { setView(await get<InstalledAppsView>('/api/github-apps', { timeoutMs: LIST_TIMEOUT_MS })); } catch (e) { setFailed((e as Error).message); }
    setBusy(false);
  };
  const use = async (a: InstalledApp) => {
    setBusy(true);
    try {
      const report = await get<PluginsReport>('/api/plugins');
      const inst = report.instances.find((i) => i.role === 'job-source' && i.instance.name === source);
      if (!inst) toast.error(`No job source named ${source} in Plugins → Job sources`);
      else await sendPluginsEdit({ action: 'options', role: 'job-source', name: source, options: { ...inst.instance.options, appId: a.appId, slug: a.slug }, version: report.config.version }, `${source} uses the app ${a.slug}`);
    } catch (e) {
      toast.error((e as Error).message);
    }
    setBusy(false);
  };
  return (
    <div data-installed-apps className="space-y-1">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void list()}>List installed apps</Button>
      {failed && <div className="text-bad">{failed}</div>}
      {view?.notConnected && <div data-installed-apps-none>{view.notConnected}</div>}
      {view && !view.notConnected && view.apps.length === 0 && <div data-installed-apps-none>No GitHub App is installed on an organization your GitHub connection can list.</div>}
      {view?.apps.map((a) => (
        <div key={`${a.account} ${a.appId}`} data-installed-app={a.appId} className="flex flex-wrap items-center gap-x-2">
          <span><GhLink url={a.settingsUrl}>{a.slug}</GhLink> on <span className="font-mono">{a.account}</span> · app id <span className="num">{a.appId}</span></span>
          {canAdmin && <Button size="xs" variant="outline" disabled={busy} title="Sets this app's id and slug on the source" onClick={() => void use(a)}>Use this app</Button>}
        </div>
      ))}
      {view && view.refused.length > 0 && (
        <div data-installed-apps-refused className="text-muted-foreground">
          {view.refused.map((r) => <div key={r.account}><span className="font-mono">{r.account}</span>: {r.error}</div>)}
        </div>
      )}
    </div>
  );
}
