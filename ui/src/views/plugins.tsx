// Plugins (design.md "UI and mutation"): per role, the configured instances, each with its own
// options form (components/plugin-form.tsx) for every option, command-bearing ones too (issue #198), and
// for a list role Add and Remove. Refreshes every 15 s unless a form holds unsaved edits. Every shipped
// plugin of a list role has a switch that enables or disables it (issue #142). A notifier shows its
// actions (issue #378): Send test event, Send open questions.
import { Inbox, Package, Puzzle, RefreshCw, Send } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Empty, Panel } from '@/components/panel';
import { AddInstance, InstanceForm, PluginSelector, pluginEditsUnsaved, sendPluginsEdit } from '@/components/plugin-form';
import { SendAction } from '@/components/send-action';
import { StatusBadge } from '@/components/status';
import { PluginStore } from '@/views/plugin-store';
import { isListRole, isSelectable, ROLE_TITLES, shippedPlugins, toggleEdit } from '@/model/plugins';
import type { PluginsReport, Role } from '@/model/wire';
import { refreshPlugins, useHopper } from '@/store';
import { useCanAdmin } from '@/store/selectors';

const REFRESH_MS = 15000;

function RoleBlock({ role, report }: { role: Role; report: PluginsReport }) {
  const instances = report.instances.filter((i) => i.role === role);
  return (
    <Panel title={ROLE_TITLES[role]} icon={Puzzle} count={instances.length || ''} bodyClassName="space-y-3"
      action={role === 'router' ? <span className="text-xs text-muted-foreground">{report.router.selection}</span> : undefined}>
      {isSelectable(role) && <PluginSelector role={role} />}
      {isListRole(role) && <AddInstance role={role} />}
      {role === 'machine-source' && <div className="text-xs text-muted-foreground">attach an ssh machine from the Machines view; a container or client target with its script</div>}
      {instances.length
        ? instances.map((i) => (
          <div key={i.instance.name} className="space-y-2">
            <InstanceForm role={role} inst={i.instance} />
            {role === 'notifier' && <NotifierActions name={i.instance.name} report={report} />}
          </div>
        ))
        : <Empty>{role === 'escalation-level' ? 'none — questions go straight to the owner' : 'none'}</Empty>}
    </Panel>
  );
}

/** A running notifier's actions (issue #378), the ones GET /api/plugins lists for it. */
function NotifierActions({ name, report }: { name: string; report: PluginsReport }) {
  const authed = useCanAdmin();
  const actions = report.notifiers.instances.find((n) => n.instance.name === name)?.actions ?? [];
  if (!authed || !actions.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {actions.includes('test') && <SendAction label="Send test event" icon={Send} path="/ui/api/notifiers" body={{ action: 'test', name }} />}
      {actions.includes('send-open') && <SendAction label="Send open questions" icon={Inbox} path="/ui/api/notifiers" body={{ action: 'send-open', name }} />}
    </div>
  );
}

/** The shipped plugins, each with its switch (issue #142); a switch applies at once (issue #356). */
function ShippedPlugins({ report }: { report: PluginsReport }) {
  const authed = useCanAdmin();
  const [busy, setBusy] = useState<string | null>(null);
  const shipped = shippedPlugins(report);
  const flip = async (p: (typeof shipped)[number]) => {
    const edit = toggleEdit(report, p);
    if (!edit) return;
    setBusy(p.id);
    await sendPluginsEdit(edit, `${p.enabled ? 'Disabled' : 'Enabled'} ${p.id}`);
    setBusy(null);
  };
  return (
    <Panel title="Shipped plugins" icon={Package} count={shipped.filter((p) => p.enabled).length || ''} bodyClassName="divide-y">
      {shipped.map((p) => (
        <div key={`${p.role}:${p.id}`} className="flex items-start gap-3 py-2 first:pt-0 last:pb-0">
          <Switch className="mt-0.5" checked={p.enabled} aria-label={`${p.enabled ? 'Disable' : 'Enable'} ${p.id}`}
            disabled={!authed || busy !== null || p.blocked !== undefined} onCheckedChange={() => void flip(p)} />
          <div className="min-w-0 text-xs">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono text-sm">{p.id}</span>
              <span className="text-muted-foreground">{ROLE_TITLES[p.role]}</span>
            </div>
            <div className="text-muted-foreground">{p.describe}</div>
            {p.blocked && <div className="text-warn">{p.blocked}</div>}
          </div>
        </div>
      ))}
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
      <Panel title="Plugins config" icon={Puzzle} bodyClassName="space-y-1.5 text-xs"
        action={authed && <Button size="sm" variant="outline" disabled={busy} onClick={() => void rescan()}><RefreshCw />Rescan</Button>}>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={c.source === 'stored' ? 'in the database' : 'built-in defaults'} tone={c.source === 'stored' ? 'ok' : 'muted'} />
          {c.loadedAt && <span className="text-muted-foreground" title="Every change applies when it is saved, without a restart; running jobs keep running">applied {new Date(c.loadedAt).toLocaleTimeString()}</span>}
        </div>
        {c.error && <div className="text-bad">{c.error}</div>}
        {[...c.warnings, ...report.warnings].map((w) => <div key={w} className="text-warn">{w}</div>)}
        {report.errors.map((e) => <div key={e.path} className="text-bad">refused plugin {e.path}: {e.error}</div>)}
      </Panel>
      <ShippedPlugins report={report} />
      <PluginStore />
      <div className="grid gap-3 xl:grid-cols-2">{report.roles.map((r) => <RoleBlock key={r} role={r} report={report} />)}</div>
    </div>
  );
}
