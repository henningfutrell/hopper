// One plugin instance's options form (Remove for a list role's instance; an escalation level also
// moves earlier or later), a one-instance role's plugin selector and a list role's Add form (design.md "UI and mutation"), shared by the Plugins view, the Routing view and the Question gates panel. Each form keeps its own
// unsaved edits; command-bearing options are shown, never edited (plugins.yaml only); an option the plugin lists
// choices for (a model) is picked from them, not typed (issue #151). One Save sends
// one instance's whole options object through POST /ui/api/plugins against GET /api/plugins'
// version. Reads the report and the session from the store.
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Confirm } from '@/components/confirm';
import { StatusBadge } from '@/components/status';
import { post, SessionRejected } from '@/lib/api';
import { collectOptions, fieldKind, instanceState, isListRole, newInstance, ROLE_TITLES, shown, type Draft, type OptionSchema, type OptionsSchema } from '@/model/plugins';
import type { InstanceSpec, ListRole, OptionChoice, PluginsEdit, PluginsReport, Role, SelectableRole } from '@/model/wire';
import { refreshHealth, refreshPlugins, setPlugins, useHopper } from '@/store';
import { useCanAdmin } from '@/store/selectors';

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

function Field({ name, p, choices, current, draft, disabled, set }: {
  name: string; p: OptionSchema; choices?: OptionChoice[]; current: Record<string, unknown>; draft: Draft; disabled: boolean; set: (v: string | boolean) => void;
}) {
  const kind = fieldKind(p, choices);
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
  } else if (kind === 'choice') {
    const picked = typeof value === 'string' ? value : '';
    const listed = choices ?? [];
    input = (
      <select name={name} className={FIELD} value={picked} disabled={disabled} onChange={(e) => set(e.target.value)}>
        <option value="">{p.default !== undefined ? `default (${String(p.default)})` : '—'}</option>
        {listed.map((c) => <option key={c.value} value={c.value} title={c.description}>{c.label ? `${c.label} (${c.value})` : c.value}</option>)}
        {picked && !listed.some((c) => c.value === picked) && <option value={picked}>{picked} (not listed here)</option>}
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
  const authed = useCanAdmin();
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
  const choices = report.plugins.find((p) => p.id === inst.plugin)?.choices ?? {};
  const props = Object.entries(schema?.properties ?? {});
  const current = inst.options ?? {};
  const save = async () => {
    let options: Record<string, unknown>;
    try { options = collectOptions(current, schema, draft); } catch (e) { toast.error((e as Error).message); return; }
    setBusy(true);
    if (await sendPluginsEdit({ action: 'options', role, name: inst.name, options, version: report.config.version }, `Saved ${inst.name}`)) setDraft({});
    setBusy(false);
  };
  const remove = async (list: ListRole) => {
    setBusy(true);
    await sendPluginsEdit({ action: 'remove', role: list, name: inst.name, version: report.config.version }, `Removed ${inst.name}`);
    setBusy(false);
  };
  // An escalation level's place: 0 is the lowest, the first a question meets.
  const levels = report.instances.filter((i) => i.role === 'escalation-level').map((i) => i.instance.name);
  const at = role === 'escalation-level' ? levels.indexOf(inst.name) : -1;
  const move = async (to: number) => {
    setBusy(true);
    await sendPluginsEdit({ action: 'move', role: 'escalation-level', name: inst.name, to, version: report.config.version }, `Moved ${inst.name}`);
    setBusy(false);
  };
  const removeWhat = role === 'escalation-level'
    ? `${inst.name} leaves plugins.yaml; the next question skips it.`
    : role === 'machine-source'
      ? `${inst.name} leaves plugins.yaml and stops taking jobs at once. Refused while a job runs there or waits for an answer in a pane there.`
      : `${inst.name} leaves plugins.yaml; ${ROLE_TITLES[role].toLowerCase()} change at the next restart.`;
  return (
    <div data-slot="instance-form" data-instance={inst.name} className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        {at >= 0 && <span className="num text-xs text-muted-foreground">level {at + 1}</span>}
        <span className="font-medium">{inst.name}</span>
        <span className="font-mono text-xs text-muted-foreground">{inst.plugin}</span>
        <StatusBadge status={st.label} tone={st.tone} />
        {st.reason && <span className="text-xs break-words text-muted-foreground">{st.reason}</span>}
        {st.detection && st.detection.status !== 'available' && <span className="text-xs break-words text-muted-foreground">{st.detection.status}: {st.detection.reason}</span>}
      </div>
      {props.length
        ? <div className="grid items-center gap-x-4 gap-y-2 sm:grid-cols-[minmax(8rem,18rem)_minmax(0,1fr)]">
          {props.map(([name, p]) => <Field key={name} name={name} p={p} choices={choices[name]} current={current} draft={draft} disabled={!authed || busy}
            set={(v) => setDraft((d) => ({ ...d, [name]: v }))} />)}
        </div>
        : <div className="text-xs text-muted-foreground">no options</div>}
      {authed && (props.length > 0 || isListRole(role)) && (
        <div className="flex flex-wrap gap-2">
          {props.length > 0 && <Button size="sm" disabled={busy || !dirty} onClick={() => void save()}>Save {inst.name}</Button>}
          {dirty && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDraft({})}>Discard</Button>}
          {at > 0 && <Button size="sm" variant="ghost" aria-label={`Move ${inst.name} earlier`} title="Earlier in the climb: a question meets it sooner" disabled={busy} onClick={() => void move(at - 1)}><ArrowUp /></Button>}
          {at >= 0 && at < levels.length - 1 && <Button size="sm" variant="ghost" aria-label={`Move ${inst.name} later`} title="Later in the climb: a question meets it after the one before" disabled={busy} onClick={() => void move(at + 1)}><ArrowDown /></Button>}
          {isListRole(role) && (
            <Confirm title={`Remove ${inst.name}?`} action="Remove"
              description={removeWhat}
              onConfirm={() => void remove(role)}>
              <Button size="sm" variant="ghost" className="ml-auto text-bad" disabled={busy}>Remove</Button>
            </Confirm>
          )}
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
    await sendPluginsEdit({ action: 'select', role, plugin: pick, version: report.config.version }, `${ROLE_TITLES[role]}: ${pick}`);
    setBusy(false);
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">plugin</span>
      <select name={`plugin-${role}`} className={`${FIELD} w-auto max-w-full`} value={pick} disabled={busy} onChange={(e) => setPick(e.target.value)}>
        {choices.map((p) => <option key={p.id} value={p.id} disabled={p.detection.status !== 'available'}>{p.id}{p.builtin ? '' : ' (custom)'} — {p.detection.status}</option>)}
      </select>
      <Button size="sm" variant="outline" disabled={busy || pick === current} onClick={() => void use()}>Use</Button>
    </div>
  );
}

/** The plugin filling a one-instance role. Shown only with a UI session. */
export function PluginSelector({ role }: { role: SelectableRole }) {
  const report = useHopper((s) => s.plugins);
  const authed = useCanAdmin();
  if (!report || !authed) return null;
  const current = report.instances.find((i) => i.role === role)?.instance.plugin ?? '';
  return <Picker key={current} role={role} current={current} report={report} />;
}

/** A new instance of a list role: an available plugin, under the name typed (else the plugin id), with its defaults. */
export function AddInstance({ role }: { role: ListRole }) {
  const report = useHopper((s) => s.plugins);
  const authed = useCanAdmin();
  const [plugin, setPlugin] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  if (!report || !authed) return null;
  const choices = report.plugins.filter((p) => p.role === role);
  const pick = plugin || choices.find((p) => p.detection.status === 'available')?.id || '';
  const next = pick ? newInstance(report, role, pick, typed) : undefined;
  const add = async () => {
    if (!next || next.problem) return;
    setBusy(true);
    if (await sendPluginsEdit({ action: 'add', role, plugin: pick, name: next.name, version: report.config.version }, `Added ${next.name}`)) setTyped('');
    setBusy(false);
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">add</span>
      <select name={`add-plugin-${role}`} className={`${FIELD} w-auto max-w-full`} value={pick} disabled={busy} onChange={(e) => setPlugin(e.target.value)}>
        {choices.map((p) => <option key={p.id} value={p.id} disabled={p.detection.status !== 'available'}>{p.id}{p.builtin ? '' : ' (custom)'} — {p.detection.status}</option>)}
      </select>
      <Input name={`add-name-${role}`} className="h-8 w-40 font-mono text-xs" placeholder={pick || 'name'} value={typed} disabled={busy} onChange={(e) => setTyped(e.target.value)} />
      <Button size="sm" variant="outline" disabled={busy || !next || next.problem !== undefined} onClick={() => void add()}>Add</Button>
      {next?.problem && <span className="text-bad">{next.problem}</span>}
    </div>
  );
}
