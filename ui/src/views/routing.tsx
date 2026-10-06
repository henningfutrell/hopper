// Routing (design.md "UI manages everything (issue #18)"): which router advises, in which mode;
// which queue sorter orders the waiting jobs; and the routing rules that set a new job's machine,
// executor or priority at intake. Pickers list every plugin of the role — one that cannot run here
// is shown with why, never offered. Phone width first: everything stacks.
import { ArrowDown, ArrowUp, ListOrdered, Plus, Route, Trash2, Waypoints } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Empty, Panel } from '@/components/panel';
import { FIELD, InstanceForm, pluginEditsUnsaved, sendPluginsEdit } from '@/components/plugin-form';
import { StatusBadge } from '@/components/status';
import { post, SessionRejected } from '@/lib/api';
import {
  blankRule, choices, draftsProblem, fromDraft, machineOptions, MATCH_FIELDS, move, toDraft, type Choice, type RuleDraft,
} from '@/model/routing';
import type { PluginsEdit, PluginsReport, RoutingReport } from '@/model/wire';
import { act, refreshHealth, refreshPlugins, refreshRouting, setRouting, useHopper } from '@/store';
import { useCanAdmin } from '@/store/selectors';

const REFRESH_MS = 15000;

/** What the Routing view's panels share: the plugins report, the session, and one select in flight at a time. */
interface PluginCtx {
  report: PluginsReport;
  authed: boolean;
  busy: boolean;
  send: (edit: PluginsEdit, done: string) => Promise<boolean>;
}

function Picker({ role, ctx }: { role: 'router' | 'queue-sorter'; ctx: PluginCtx }) {
  const list = choices(ctx.report, role);
  const use = (c: Choice) => void ctx.send({ action: 'select', role, plugin: c.id, version: ctx.report.config.version }, `${role === 'router' ? 'Router' : 'Queue sorter'}: ${c.id}`);
  return (
    <ul className="grid gap-2">
      {list.map((c) => (
        <li key={c.id} className="flex flex-wrap items-start gap-2 rounded-md border p-3" aria-current={c.current ? 'true' : undefined}>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm font-medium">{c.id}</span>
              {!c.builtin && <span className="rounded border px-1 text-[10px] text-muted-foreground">custom</span>}
              <StatusBadge status={c.status} tone={c.status === 'available' ? 'ok' : c.status === 'needs-setup' ? 'warn' : 'bad'} />
              {c.current && <StatusBadge status="configured" tone="busy" />}
            </div>
            <div className="text-xs text-muted-foreground">{c.describe}</div>
            {c.why && <div className="text-xs break-words text-muted-foreground">{c.why}</div>}
            {c.command && <div className="text-xs">set up with <code className="font-mono break-all">{c.command}</code></div>}
          </div>
          {ctx.authed && c.selectable && !c.current && (
            <Button size="lg" variant="outline" disabled={ctx.busy} onClick={() => use(c)}>Use</Button>
          )}
        </li>
      ))}
    </ul>
  );
}

function RouterPanel({ ctx }: { ctx: PluginCtx }) {
  const mode = useHopper((s) => s.health?.routerMode ?? 'shadow');
  const r = ctx.report.router;
  const inst = ctx.report.instances.find((i) => i.role === 'router')?.instance;
  const setMode = async (m: 'shadow' | 'active') => {
    if (await act('/ui/api/router-mode', { mode: m }, `Router mode: ${m}`)) await refreshHealth().catch(() => {});
  };
  return (
    <Panel title="Router" icon={Waypoints} bodyClassName="space-y-3"
      action={<span className="text-xs text-muted-foreground">{r.selection === 'file' ? 'picked' : 'detected'}</span>}>
      <div className="space-y-1 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span>Advising now:</span><span className="font-mono">{r.active}</span>
          {r.fallback ? <StatusBadge status="fallback" tone="warn" /> : <StatusBadge status="active" tone="ok" />}
        </div>
        {r.reason && <div className="text-xs break-words text-warn">{r.reason}</div>}
      </div>
      <div className="space-y-1.5">
        <div className="text-xs text-muted-foreground">Mode — shadow records advice and never applies it; active lets it hold and reorder jobs.</div>
        <div className="flex gap-2" role="group" aria-label="Router mode">
          {(['shadow', 'active'] as const).map((m) => (
            <Button key={m} size="lg" className="flex-1 sm:flex-none" variant={mode === m ? 'default' : 'outline'} aria-pressed={mode === m}
              disabled={!ctx.authed || mode === m} onClick={() => void setMode(m)}>{m}</Button>
          ))}
        </div>
      </div>
      <Picker role="router" ctx={ctx} />
      {inst && <InstanceForm role="router" inst={inst} />}
    </Panel>
  );
}

function SorterPanel({ ctx }: { ctx: PluginCtx }) {
  const q = ctx.report.queueSorter;
  return (
    <Panel title="Queue sorter" icon={ListOrdered} bodyClassName="space-y-3">
      <div className="space-y-1 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span>Ordering now:</span><span className="font-mono">{q.active}</span>
          {q.fallback ? <StatusBadge status="fallback" tone="warn" /> : <StatusBadge status="active" tone="ok" />}
        </div>
        {q.reason && <div className="text-xs break-words text-warn">{q.reason}</div>}
        <div className="text-xs text-muted-foreground">Orders the waiting jobs each Decision. It never admits or holds one; lanes, usage and the router still decide that.</div>
        <div className="text-xs text-muted-foreground">It is also the pre-sort: the order, and the rejections, of new jobs at the queue gate (<a className="underline underline-offset-4" href="#queue">Queue</a>).</div>
      </div>
      <Picker role="queue-sorter" ctx={ctx} />
      <InstanceForm role="queue-sorter" inst={q.instance} />
    </Panel>
  );
}

const MATCH_HINT: Record<(typeof MATCH_FIELDS)[number], string> = {
  source: 'any source', repo: 'owner/name, * for any', label: 'has this label', author: 'GitHub login', title: 'title contains',
};

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid gap-1 text-xs"><span className="text-muted-foreground">{label}</span>{children}</label>;
}

function RuleCard({ d, i, n, sources, machines, executors, disabled, set, moveBy, remove }: {
  d: RuleDraft; i: number; n: number; sources: string[]; machines: string[]; executors: string[]; disabled: boolean;
  set: (d: RuleDraft) => void; moveBy: (by: -1 | 1) => void; remove: () => void;
}) {
  const input = 'h-9 font-mono text-sm';
  const select = `${FIELD} h-9 text-sm`;
  return (
    <li className="space-y-3 rounded-md border p-3">
      <div className="flex items-center gap-1">
        <span className="num w-6 text-xs text-muted-foreground">{i + 1}.</span>
        <Input aria-label={`rule ${i + 1} name`} className={`${input} min-w-0 flex-1`} value={d.name} disabled={disabled}
          onChange={(e) => set({ ...d, name: e.target.value })} />
        <Button size="icon-lg" variant="ghost" aria-label="Move up" disabled={disabled || i === 0} onClick={() => moveBy(-1)}><ArrowUp /></Button>
        <Button size="icon-lg" variant="ghost" aria-label="Move down" disabled={disabled || i === n - 1} onClick={() => moveBy(1)}><ArrowDown /></Button>
        <Button size="icon-lg" variant="ghost" aria-label="Delete rule" disabled={disabled} onClick={remove}><Trash2 /></Button>
      </div>
      <fieldset className="grid gap-2 sm:grid-cols-2">
        <legend className="mb-1 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">When an item matches (all given)</legend>
        <Labeled label="source">
          <select className={select} value={d.match.source} disabled={disabled} onChange={(e) => set({ ...d, match: { ...d.match, source: e.target.value } })}>
            <option value="">any source</option>
            {[...new Set([...sources, ...(d.match.source ? [d.match.source] : [])])].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Labeled>
        {MATCH_FIELDS.filter((f) => f !== 'source').map((f) => (
          <Labeled key={f} label={f}>
            <Input className={input} value={d.match[f]} placeholder={MATCH_HINT[f]} disabled={disabled}
              onChange={(e) => set({ ...d, match: { ...d.match, [f]: e.target.value } })} />
          </Labeled>
        ))}
      </fieldset>
      <fieldset className="grid gap-2 sm:grid-cols-3">
        <legend className="mb-1 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">Set on the new job</legend>
        <Labeled label="machine (pin)">
          <select className={select} value={d.set.machine} disabled={disabled} onChange={(e) => set({ ...d, set: { ...d.set, machine: e.target.value } })}>
            <option value="">any machine</option>
            {[...new Set([...machines, ...(d.set.machine ? [d.set.machine] : [])])].map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </Labeled>
        <Labeled label="executor">
          <select className={select} value={d.set.executor} disabled={disabled} onChange={(e) => set({ ...d, set: { ...d.set, executor: e.target.value } })}>
            <option value="">the source's</option>
            {[...new Set([...executors, ...(d.set.executor ? [d.set.executor] : [])])].map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </Labeled>
        <Labeled label="priority 0..100">
          <Input className={input} type="number" inputMode="numeric" min={0} max={100} step={1} placeholder="the source's" value={d.set.priority} disabled={disabled}
            onChange={(e) => set({ ...d, set: { ...d.set, priority: e.target.value } })} />
        </Labeled>
      </fieldset>
    </li>
  );
}

function RulesPanel({ ctx }: { ctx: PluginCtx }) {
  const machinesNow = useHopper((s) => s.machines);
  const report = useHopper((s) => s.routing);
  const error = useHopper((s) => s.routingError);
  const [drafts, setDrafts] = useState<RuleDraft[] | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = useRef(false);
  useEffect(() => { dirty.current = drafts !== null; }, [drafts]);
  useEffect(() => {
    const t = setInterval(() => { if (!dirty.current) void refreshRouting(); }, REFRESH_MS);
    return () => clearInterval(t);
  }, []);
  // On open, and after any edit of the plugins config (a router or sorter picked above changes its version).
  const fileVersion = ctx.report.config.version;
  useEffect(() => { if (!dirty.current) void refreshRouting(); }, [fileVersion]);

  if (!report) return <Panel title="Routing rules" icon={Route}><Empty>{error ?? 'loading…'}</Empty></Panel>;
  const list = drafts ?? report.rules.map(toDraft);
  const edit = (next: RuleDraft[]) => setDrafts(next);
  const problem = draftsProblem(list);
  const disabled = !ctx.authed || busy;
  const sources = ctx.report.instances.filter((i) => i.role === 'job-source').map((i) => i.instance.name);
  const save = async () => {
    setBusy(true);
    try {
      setRouting(await post<RoutingReport>('/ui/api/routing', { rules: list.map(fromDraft), version: report.version }));
      setDrafts(null);
      void refreshPlugins(); // the plugins config has a new version
      toast.success('Routing rules saved — they apply to new jobs');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false });
      toast.error((e as Error).message);
      if (/changed since it was read/.test((e as Error).message)) await refreshRouting();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Routing rules" icon={Route} count={list.length} bodyClassName="space-y-3">
      <p className="text-xs text-muted-foreground">
        When a source item becomes a job, the rules are tried in order and the <b>first</b> match sets the job's machine, executor or priority.
        A change applies to new jobs only; jobs already queued keep how they were routed.
      </p>
      {report.error && <div className="text-xs text-bad">{report.error}</div>}
      {report.skipped.map((s) => <div key={s.rule} className="text-xs text-warn">skipped at intake: {s.rule} — {s.reason}</div>)}
      {list.length
        ? <ol className="grid gap-3">{list.map((d, i) => (
          <RuleCard key={i} d={d} i={i} n={list.length} sources={sources} disabled={disabled}
            machines={machineOptions(machinesNow, report.targets.machines)} executors={report.targets.executors}
            set={(next) => edit(list.map((x, j) => (j === i ? next : x)))}
            moveBy={(by) => edit(move(list, i, by))} remove={() => edit(list.filter((_, j) => j !== i))} />
        ))}</ol>
        : <Empty>no rules: every job keeps its source's executor and priority, on any machine</Empty>}
      {ctx.authed && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="lg" variant="outline" disabled={busy} onClick={() => edit([...list, blankRule(list.map((d) => d.name))])}><Plus />Add rule</Button>
          <Button size="lg" disabled={busy || drafts === null || problem !== undefined} onClick={() => void save()}>Save rules</Button>
          {drafts !== null && <Button size="lg" variant="ghost" disabled={busy} onClick={() => setDrafts(null)}>Discard</Button>}
          {drafts !== null && problem && <span className="text-xs text-warn">{problem}</span>}
        </div>
      )}
    </Panel>
  );
}

export function Routing() {
  const authed = useCanAdmin();
  const report = useHopper((s) => s.plugins);
  const error = useHopper((s) => s.pluginsError);
  const [busy, setBusy] = useState(false);
  // This view may be the first one opened: it loads the plugins report, and refreshes it while no form holds unsaved edits.
  useEffect(() => {
    void refreshPlugins();
    const t = setInterval(() => { if (!pluginEditsUnsaved()) void refreshPlugins(); }, REFRESH_MS);
    return () => clearInterval(t);
  }, []);
  if (!report) return <Panel title="Routing" icon={Route}><Empty>{error ?? 'loading…'}</Empty></Panel>;
  const send = async (edit: PluginsEdit, done: string) => { setBusy(true); try { return await sendPluginsEdit(edit, done); } finally { setBusy(false); } };
  const ctx: PluginCtx = { report, authed, busy, send };
  return (
    <div className="space-y-3">
      <div className="grid gap-3 xl:grid-cols-2">
        <RouterPanel ctx={ctx} />
        <SorterPanel ctx={ctx} />
      </div>
      <RulesPanel ctx={ctx} />
    </div>
  );
}
