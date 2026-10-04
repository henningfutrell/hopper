// One plugin instance's options form and a one-instance role's plugin selector (design.md "UI and
// mutation"), shared by the Plugins view, the Routing view and the Question gates panel. Each form keeps its own
// unsaved edits; command-bearing options are shown, never edited (plugins.yaml only). One Save sends
// one instance's whole options object through POST /ui/api/plugins against GET /api/plugins'
// version. Reads the report and the session from the store.
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { StatusBadge } from '@/components/status';
import { post, SessionRejected } from '@/lib/api';
import { collectOptions, fieldKind, instanceState, ROLE_TITLES, shown, type Draft, type OptionSchema, type OptionsSchema } from '@/model/plugins';
import type { InstanceSpec, PluginsEdit, PluginsReport, Role, SelectableRole } from '@/model/wire';
import { refreshHealth, refreshPlugins, setPlugins, useHopper } from '@/store';

export const FIELD = 'h-8 w-full rounded-lg border border-input bg-transparent px-2.5 font-mono text-xs disabled:opacity-50 dark:bg-input/30';

/** Instances whose forms hold unsaved edits: a view does not refresh the report under them. */
const unsaved = new Set<string>();
export const pluginEditsUnsaved = (): boolean => unsaved.size > 0;

/** POST /ui/api/plugins; the answer is the new report. Failures toast; a stale version reloads the report. */
export async function sendPluginsEdit(edit: PluginsEdit, done: string): Promise<boolean> {
  try {
    setPlugins(await post<PluginsReport>('/ui/api/plugins', edit));
    toast.success(done);
    refreshHealth().catch(() => {});
    return true;
  } catch (e) {
    if (e instanceof SessionRejected) useHopper.setState({ authed: false });
    toast.error((e as Error).message);
    if (/changed since it was read/.test((e as Error).message)) await refreshPlugins();
    return false;
  }
}

const schemaOf = (report: PluginsReport, id: string) => report.plugins.find((p) => p.id === id)?.options as OptionsSchema | undefined;

function Field({ name, p, current, draft, disabled, set }: {
  name: string; p: OptionSchema; current: Record<string, unknown>; draft: Draft; disabled: boolean; set: (v: string | boolean) => void;
}) {
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
  const value = name in draft ? draft[name] : current[name];
  let input: React.ReactNode;
  if (kind === 'boolean') {
    input = <input type="checkbox" name={name} className="size-4 justify-self-start" checked={(value ?? p.default) === true} disabled={disabled} onChange={(e) => set(e.target.checked)} />;
  } else if (kind === 'enum') {
    input = (
      <select name={name} className={FIELD} value={typeof value === 'string' ? value : ''} disabled={disabled} onChange={(e) => set(e.target.value)}>
        <option value="">{p.default !== undefined ? `default (${String(p.default)})` : '—'}</option>
        {(p.enum ?? []).map((v) => <option key={String(v)} value={String(v)}>{String(v)}</option>)}
      </select>
    );
  } else if (kind === 'number' || kind === 'string') {
    input = <Input name={name} type={kind === 'number' ? 'number' : 'text'} className="h-8 font-mono text-xs" value={typeof value === 'string' && name in draft ? value : shown(p, value)}
      placeholder={shown(p, p.default)} disabled={disabled} onChange={(e) => set(e.target.value)} />;
  } else {
    input = <Textarea name={name} rows={2} className="font-mono text-xs" value={typeof value === 'string' && name in draft ? value : shown(p, value)}
      placeholder={kind === 'lines' ? 'one per line' : 'JSON'} disabled={disabled} onChange={(e) => set(e.target.value)} />;
  }
  return <>{label}{input}</>;
}

/** One instance: its plugin, state, and options form with Save and Discard. */
export function InstanceForm({ role, inst }: { role: Role; inst: InstanceSpec }) {
  const report = useHopper((s) => s.plugins);
  const authed = useHopper((s) => s.authed);
  const [draft, setDraft] = useState<Draft>({});
  const [busy, setBusy] = useState(false);
  const k = `${role}:${inst.name}`;
  const dirty = Object.keys(draft).length > 0;
  useEffect(() => {
    if (dirty) unsaved.add(k); else unsaved.delete(k);
    return () => { unsaved.delete(k); };
  }, [k, dirty]);
  if (!report) return null;
  const st = instanceState(report, role, inst.name);
  const schema = schemaOf(report, inst.plugin);
  const props = Object.entries(schema?.properties ?? {});
  const current = inst.options ?? {};
  const save = async () => {
    let options: Record<string, unknown>;
    try { options = collectOptions(current, schema, draft); } catch (e) { toast.error((e as Error).message); return; }
    setBusy(true);
    if (await sendPluginsEdit({ action: 'options', role, name: inst.name, options, version: report.config.version }, `Saved ${inst.name}`)) setDraft({});
    setBusy(false);
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
          {props.map(([name, p]) => <Field key={name} name={name} p={p} current={current} draft={draft} disabled={!authed || busy}
            set={(v) => setDraft((d) => ({ ...d, [name]: v }))} />)}
        </div>
        : <div className="text-xs text-muted-foreground">no options</div>}
      {authed && props.length > 0 && (
        <div className="flex gap-2">
          <Button size="sm" disabled={busy || !dirty} onClick={() => void save()}>Save {inst.name}</Button>
          {dirty && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDraft({})}>Discard</Button>}
        </div>
      )}
    </div>
  );
}

function Picker({ role, current, report }: { role: SelectableRole; current: string; report: PluginsReport }) {
  const [pick, setPick] = useState(current);
  const [busy, setBusy] = useState(false);
  const choices = report.plugins.filter((p) => p.role === role);
  const use = async () => {
    setBusy(true);
    await sendPluginsEdit({ action: 'select', role, plugin: pick || null, version: report.config.version }, `${ROLE_TITLES[role]}: ${pick || 'none'}`);
    setBusy(false);
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">plugin</span>
      <select name={`plugin-${role}`} className={`${FIELD} w-auto max-w-full`} value={pick} disabled={busy} onChange={(e) => setPick(e.target.value)}>
        {role === 'answerer' && <option value="">none</option>}
        {choices.map((p) => <option key={p.id} value={p.id} disabled={p.detection.status !== 'available'}>{p.id}{p.builtin ? '' : ' (custom)'} — {p.detection.status}</option>)}
      </select>
      <Button size="sm" variant="outline" disabled={busy || pick === current} onClick={() => void use()}>Use</Button>
    </div>
  );
}

/** The plugin filling a one-instance role (the answerer: or none). Shown only with a UI session. */
export function PluginSelector({ role }: { role: SelectableRole }) {
  const report = useHopper((s) => s.plugins);
  const authed = useHopper((s) => s.authed);
  if (!report || !authed) return null;
  const current = report.instances.find((i) => i.role === role)?.instance.plugin ?? '';
  return <Picker key={current} role={role} current={current} report={report} />;
}
