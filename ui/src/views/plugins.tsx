// Plugins (design.md "UI and mutation"): per role, the configured instances, each with its own
// options form (components/plugin-instance.tsx, shared with the Routing view).
import { Puzzle, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Empty, Panel } from '@/components/panel';
import { FIELD, InstanceCard, usePluginEditor, type PluginCtx } from '@/components/plugin-instance';
import { StatusBadge } from '@/components/status';
import { instanceState, isSelectable, ROLE_TITLES } from '@/model/plugins';
import type { InstanceSpec, Role, SelectableRole } from '@/model/wire';
import { useHopper } from '@/store';

function Selector({ role, current, ctx }: { role: SelectableRole; current?: InstanceSpec; ctx: PluginCtx }) {
  const choices = ctx.report.plugins.filter((p) => p.role === role);
  const [pick, setPick] = useState(current?.plugin ?? '');
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">plugin</span>
      <select className={`${FIELD} w-auto`} value={pick} disabled={ctx.busy} onChange={(e) => setPick(e.target.value)}>
        {role === 'answerer' && <option value="">none</option>}
        {choices.map((p) => <option key={p.id} value={p.id} disabled={p.detection.status !== 'available'}>{p.id}{p.builtin ? '' : ' (custom)'} — {p.detection.status}</option>)}
      </select>
      <Button size="sm" variant="outline" disabled={ctx.busy || pick === (current?.plugin ?? '')}
        onClick={() => void ctx.send({ action: 'select', role, plugin: pick || null, version: ctx.report.config.version }, `${ROLE_TITLES[role]}: ${pick || 'none'}`)}>Use</Button>
    </div>
  );
}

function RoleBlock({ role, ctx }: { role: Role; ctx: PluginCtx }) {
  const instances = ctx.report.instances.filter((i) => i.role === role);
  const first = instances[0];
  const rolePending = first ? instanceState(ctx.report, role, first.instance.name).rolePending : false;
  return (
    <Panel title={ROLE_TITLES[role]} icon={Puzzle} count={instances.length || ''} bodyClassName="space-y-3"
      action={<>{role === 'router' && <span className="text-xs text-muted-foreground">{ctx.report.router.selection}</span>}
        {rolePending && <StatusBadge status="changed — restart pending" tone="warn" />}</>}>
      {isSelectable(role) && ctx.authed && <Selector key={first?.instance.plugin ?? ''} role={role} current={first?.instance} ctx={ctx} />}
      {instances.length
        ? instances.map((i) => <InstanceCard key={i.instance.name} role={role} inst={i.instance} ctx={ctx} />)
        : <Empty>{role === 'answerer' ? 'none — questions go straight to the owner' : 'none'}</Empty>}
    </Panel>
  );
}

export function Plugins() {
  const authed = useHopper((s) => s.authed);
  const report = useHopper((s) => s.plugins);
  const error = useHopper((s) => s.pluginsError);
  const editor = usePluginEditor();
  const { busy, send } = editor;

  if (!report) return <Panel title="Plugins" icon={Puzzle}><Empty>{error ?? 'loading…'}</Empty></Panel>;
  const ctx: PluginCtx = { report, authed, ...editor };
  const c = report.config;
  return (
    <div className="space-y-3">
      <Panel title="plugins.yaml" icon={Puzzle} bodyClassName="space-y-1.5 text-xs"
        action={authed && <Button size="sm" variant="outline" disabled={busy} onClick={() => void send({ action: 'rescan' }, 'Plugins rescanned')}><RefreshCw />Rescan</Button>}>
        <div className="flex flex-wrap items-center gap-2">
          <code className="font-mono break-all">{c.path}</code>
          <StatusBadge status={c.source === 'file' ? 'from file' : 'built-in defaults'} tone={c.source === 'file' ? 'ok' : 'muted'} />
          {c.loadedAt && <span className="text-muted-foreground">loaded {new Date(c.loadedAt).toLocaleTimeString()}</span>}
        </div>
        {c.error && <div className="text-bad">{c.error}</div>}
        {[...c.warnings, ...report.warnings].map((w) => <div key={w} className="text-warn">{w}</div>)}
        {report.errors.map((e) => <div key={e.path} className="text-bad">refused plugin {e.path}: {e.error}</div>)}
      </Panel>
      <div className="grid gap-3 xl:grid-cols-2">{report.roles.map((r) => <RoleBlock key={r} role={r} ctx={ctx} />)}</div>
    </div>
  );
}
