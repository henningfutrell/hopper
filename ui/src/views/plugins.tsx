// Plugins (design.md "UI and mutation"): per role, the configured instances, each with its own
// options form (components/plugin-form.tsx), and for a list role Add and Remove; command-bearing options are shown, never edited
// (plugins.yaml only). Refreshes every 15 s unless a form holds unsaved edits.
import { Puzzle, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Empty, Panel } from '@/components/panel';
import { AddInstance, InstanceForm, PluginSelector, pluginEditsUnsaved, sendPluginsEdit } from '@/components/plugin-form';
import { StatusBadge } from '@/components/status';
import { PluginStore } from '@/views/plugin-store';
import { instanceState, isListRole, isSelectable, ROLE_TITLES } from '@/model/plugins';
import type { PluginsReport, Role } from '@/model/wire';
import { refreshPlugins, useHopper } from '@/store';
import { useCanAdmin } from '@/store/selectors';

const REFRESH_MS = 15000;

function RoleBlock({ role, report }: { role: Role; report: PluginsReport }) {
  const instances = report.instances.filter((i) => i.role === role);
  const first = instances[0];
  const rolePending = first ? instanceState(report, role, first.instance.name).rolePending : false;
  return (
    <Panel title={ROLE_TITLES[role]} icon={Puzzle} count={instances.length || ''} bodyClassName="space-y-3"
      action={<>{role === 'router' && <span className="text-xs text-muted-foreground">{report.router.selection}</span>}
        {rolePending && <StatusBadge status="changed — restart pending" tone="warn" />}</>}>
      {isSelectable(role) && <PluginSelector role={role} />}
      {isListRole(role) && <AddInstance role={role} />}
      {role === 'machine-source' && <div className="text-xs text-muted-foreground">attach an ssh machine from the Machines view; a container or client target with its script</div>}
      {instances.length
        ? instances.map((i) => <InstanceForm key={i.instance.name} role={role} inst={i.instance} />)
        : <Empty>{role === 'escalation-level' ? 'none — questions go straight to the owner' : 'none'}</Empty>}
    </Panel>
  );
}

export function Plugins() {
  const authed = useCanAdmin();
  const report = useHopper((s) => s.plugins);
  const error = useHopper((s) => s.pluginsError);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void refreshPlugins();
    const t = setInterval(() => { if (!pluginEditsUnsaved()) void refreshPlugins(); }, REFRESH_MS);
    return () => clearInterval(t);
  }, []);

  if (!report) return <Panel title="Plugins" icon={Puzzle}><Empty>{error ?? 'loading…'}</Empty></Panel>;
  const rescan = async () => { setBusy(true); await sendPluginsEdit({ action: 'rescan' }, 'Plugins rescanned'); setBusy(false); };
  const c = report.config;
  return (
    <div className="space-y-3">
      <Panel title="plugins.yaml" icon={Puzzle} bodyClassName="space-y-1.5 text-xs"
        action={authed && <Button size="sm" variant="outline" disabled={busy} onClick={() => void rescan()}><RefreshCw />Rescan</Button>}>
        <div className="flex flex-wrap items-center gap-2">
          <code className="font-mono break-all">{c.document}</code>
          <StatusBadge status={c.source === 'document' ? 'in the database' : 'built-in defaults'} tone={c.source === 'document' ? 'ok' : 'muted'} />
          {c.loadedAt && <span className="text-muted-foreground">loaded {new Date(c.loadedAt).toLocaleTimeString()}</span>}
        </div>
        {c.error && <div className="text-bad">{c.error}</div>}
        {[...c.warnings, ...report.warnings].map((w) => <div key={w} className="text-warn">{w}</div>)}
        {report.errors.map((e) => <div key={e.path} className="text-bad">refused plugin {e.path}: {e.error}</div>)}
      </Panel>
      <PluginStore />
      <div className="grid gap-3 xl:grid-cols-2">{report.roles.map((r) => <RoleBlock key={r} role={r} report={report} />)}</div>
    </div>
  );
}
