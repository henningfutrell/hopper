// One plugin instance's options form (design.md "UI and mutation"), shared by the Plugins and Routing
// views: command-bearing options are shown, never edited (plugins.yaml only); one Save sends one
// instance's whole options object. `usePluginEditor` holds the unsaved drafts and sends edits;
// plugins.yaml is re-read every 15 s unless a form holds unsaved edits.
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { StatusBadge } from '@/components/status';
import { post, SessionRejected } from '@/lib/api';
import { collectOptions, fieldKind, instanceState, shown, type Draft, type OptionSchema, type OptionsSchema } from '@/model/plugins';
import type { InstanceSpec, PluginsEdit, PluginsReport, Role } from '@/model/wire';
import { refreshHealth, refreshPlugins, setPlugins, useHopper } from '@/store';

const REFRESH_MS = 15000;

export const FIELD = 'h-8 w-full rounded-lg border border-input bg-transparent px-2.5 font-mono text-xs disabled:opacity-50 dark:bg-input/30';

export interface PluginCtx {
  report: PluginsReport;
  authed: boolean;
  busy: boolean;
  drafts: Record<string, Draft>;
  setDraft: (key: string, name: string, v: string | boolean) => void;
  discard: (key: string) => void;
  send: (edit: PluginsEdit, done: string, key?: string) => Promise<boolean>;
}

const schemaOf = (report: PluginsReport, id: string) => report.plugins.find((p) => p.id === id)?.options as OptionsSchema | undefined;

export function Field({ name, p, current, draft, ctx, k }: { name: string; p: OptionSchema; current: Record<string, unknown>; draft: Draft; ctx: PluginCtx; k: string }) {
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

export function InstanceCard({ role, inst, ctx }: { role: Role; inst: InstanceSpec; ctx: PluginCtx }) {
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

/** Drafts and edits for the instance forms of one view; refreshes GET /api/plugins while nothing is unsaved. */
export function usePluginEditor(): Omit<PluginCtx, 'report' | 'authed'> {
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
  return {
    busy, drafts, send,
    setDraft: (key, name, v) => setDrafts((d) => ({ ...d, [key]: { ...d[key], [name]: v } })),
    discard: (key) => setDrafts(({ [key]: _gone, ...rest }) => rest),
  };
}
