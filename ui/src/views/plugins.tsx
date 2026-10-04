// Plugins (design.md "UI and mutation"): per role, the configured instances, each with its own
// options form; command-bearing options are shown, never edited (plugins.yaml only). One Save sends
// one instance's whole options object. Refreshes every 15 s unless a form holds unsaved edits.
import { Puzzle, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { post, SessionRejected } from '@/lib/api';
import { collectOptions, fieldKind, instanceState, isSelectable, ROLE_TITLES, shown, type Draft, type OptionSchema, type OptionsSchema } from '@/model/plugins';
import type { InstanceSpec, PluginsEdit, PluginsReport, Role, SelectableRole } from '@/model/wire';
import { refreshHealth, refreshPlugins, setPlugins, useHopper } from '@/store';

const REFRESH_MS = 15000;
const FIELD = 'h-8 w-full rounded-lg border border-input bg-transparent px-2.5 font-mono text-xs disabled:opacity-50 dark:bg-input/30';

interface Ctx {
  report: PluginsReport;
  authed: boolean;
  busy: boolean;
  drafts: Record<string, Draft>;
  setDraft: (key: string, name: string, v: string | boolean) => void;
  discard: (key: string) => void;
  send: (edit: PluginsEdit, done: string, key?: string) => Promise<boolean>;
}

const schemaOf = (report: PluginsReport, id: string) => report.plugins.find((p) => p.id === id)?.options as OptionsSchema | undefined;

function Field({ name, p, current, draft, ctx, k }: { name: string; p: OptionSchema; current: Record<string, unknown>; draft: Draft; ctx: Ctx; k: string }) {
  const kind = fieldKind(p);
  const label = <div className="text-xs break-words"><span className="font-mono">{name}</span>{p.description && <span className="text-muted-foreground"> — {p.description}</span>}</div>;
  if (kind === 'readonly') {
    const v = name in current ? current[name] : p.default;
    return (
      <>{label}<div className="flex flex-wrap items-center gap-1.5 text-xs">
        <code className="font-mono break-all">{shown(p, v) || '—'}</code>
        {!(name in current) && <span className="text-muted-foreground">default</span>}
        <span className="rounded border px-1 text-[10px] text-muted-foreground" title="names a program, its arguments, a directory or an executed file">plugins.yaml only</span>
      </div></>
    );
  }
  const disabled = !ctx.authed || ctx.busy;
  const value = name in draft ? draft[name] : current[name];
  const set = (v: string | boolean) => ctx.setDraft(k, name, v);
  let input: React.ReactNode;
  if (kind === 'boolean') {
    input = <input type="checkbox" className="size-4 justify-self-start" checked={(value ?? p.default) === true} disabled={disabled} onChange={(e) => set(e.target.checked)} />;
  } else if (kind === 'enum') {
    input = (
      <select className={FIELD} value={typeof value === 'string' ? value : ''} disabled={disabled} onChange={(e) => set(e.target.value)}>
        <option value="">{p.default !== undefined ? `default (${String(p.default)})` : '—'}</option>
        {(p.enum ?? []).map((v) => <option key={String(v)} value={String(v)}>{String(v)}</option>)}
      </select>
    );
  } else if (kind === 'number' || kind === 'string') {
    input = <Input type={kind === 'number' ? 'number' : 'text'} className="h-8 font-mono text-xs" value={typeof value === 'string' && name in draft ? value : shown(p, value)}
      placeholder={shown(p, p.default)} disabled={disabled} onChange={(e) => set(e.target.value)} />;
  } else {
    input = <Textarea rows={2} className="font-mono text-xs" value={typeof value === 'string' && name in draft ? value : shown(p, value)}
      placeholder={kind === 'lines' ? 'one per line' : 'JSON'} disabled={disabled} onChange={(e) => set(e.target.value)} />;
  }
  return <>{label}{input}</>;
}

function InstanceCard({ role, inst, ctx }: { role: Role; inst: InstanceSpec; ctx: Ctx }) {
  const k = `${role}:${inst.name}`;
  const st = instanceState(ctx.report, role, inst.name);
  const schema = schemaOf(ctx.report, inst.plugin);
  const props = Object.entries(schema?.properties ?? {});
  const current = inst.options ?? {};
  const draft = ctx.drafts[k] ?? {};
  const dirty = Object.keys(draft).length > 0;
  const save = async () => {
    let options: Record<string, unknown>;
    try { options = collectOptions(current, schema, draft); } catch (e) { toast.error((e as Error).message); return; }
    await ctx.send({ action: 'options', role, name: inst.name, options, version: ctx.report.config.version }, `Saved ${inst.name}`, k);
  };
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{inst.name}</span>
        <span className="font-mono text-xs text-muted-foreground">{inst.plugin}</span>
        <StatusBadge status={st.label} tone={st.tone} />
        {st.reason && <span className="text-xs break-words text-muted-foreground">{st.reason}</span>}
        {st.detection && st.detection.status !== 'available' && <span className="text-xs break-words text-muted-foreground">{st.detection.status}: {st.detection.reason}</span>}
      </div>
      {props.length
        ? <div className="grid items-center gap-x-4 gap-y-2 sm:grid-cols-[minmax(8rem,18rem)_minmax(0,1fr)]">
          {props.map(([name, p]) => <Field key={name} name={name} p={p} current={current} draft={draft} ctx={ctx} k={k} />)}
        </div>
        : <div className="text-xs text-muted-foreground">no options</div>}
      {ctx.authed && props.length > 0 && (
        <div className="flex gap-2">
          <Button size="sm" disabled={ctx.busy || !dirty} onClick={() => void save()}>Save {inst.name}</Button>
          {dirty && <Button size="sm" variant="ghost" disabled={ctx.busy} onClick={() => ctx.discard(k)}>Discard</Button>}
        </div>
      )}
    </div>
  );
}

function Selector({ role, current, ctx }: { role: SelectableRole; current?: InstanceSpec; ctx: Ctx }) {
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

function RoleBlock({ role, ctx }: { role: Role; ctx: Ctx }) {
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
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const dirty = useRef(false);
  useEffect(() => { dirty.current = Object.values(drafts).some((d) => Object.keys(d).length > 0); }, [drafts]);
  useEffect(() => {
    void refreshPlugins();
    const t = setInterval(() => { if (!dirty.current) void refreshPlugins(); }, REFRESH_MS);
    return () => clearInterval(t);
  }, []);

  const send = async (edit: PluginsEdit, done: string, key?: string): Promise<boolean> => {
    setBusy(true);
    try {
      setPlugins(await post<PluginsReport>('/ui/api/plugins', edit));
      if (key) setDrafts(({ [key]: _gone, ...rest }) => rest);
      toast.success(done);
      refreshHealth().catch(() => {});
      return true;
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false });
      toast.error((e as Error).message);
      if (/changed since it was read/.test((e as Error).message)) await refreshPlugins();
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!report) return <Panel title="Plugins" icon={Puzzle}><Empty>{error ?? 'loading…'}</Empty></Panel>;
  const ctx: Ctx = {
    report, authed, busy, drafts, send,
    setDraft: (key, name, v) => setDrafts((d) => ({ ...d, [key]: { ...d[key], [name]: v } })),
    discard: (key) => setDrafts(({ [key]: _gone, ...rest }) => rest),
  };
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
