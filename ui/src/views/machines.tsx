// Machines: what each can run, its lanes, and the usage budgets that cap them. Logged in, add this
// machine — no ssh target, its name and herdr session (issue #260) — or attach a machine over ssh (POST /ui/api/machines), edit (its name and how it is reached too, issue #205) or remove
// any machine — each a machine-source instance, edited like every plugin instance (POST /ui/api/plugins,
// issue #74) — each applied by the
// daemon without a restart (design.md "Machines from the UI", issue #18). The machine defaults — what a
// new machine starts with — are edited here too (POST /ui/api/machines/defaults, issue #142).
import { Pencil, Plus, Server, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Confirm } from '@/components/confirm';
import { ReadingGauge } from '@/components/reading';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { useNow } from '@/hooks/use-now';
import { get, post, SessionRejected } from '@/lib/api';
import { clientReleaseText, hasThisMachine, kindOf, type MachineKind } from '@/model/machines';
import { orderReadings, readingKey } from '@/model/usage';
import type { MachineDefaultsEdit, MachineEdit, MachinesConfig, MachineView, PluginsEdit } from '@/model/wire';
import { refreshLive, useHopper } from '@/store';
import { AddMachineForm, AddThisMachineForm, EditMachineForm, LocalMachineForm, MachineDefaultsForm } from './machine-forms';
import { useCanAdmin } from '@/store/selectors';

const REFRESH_MS = 15000;
const fetchConfig = () => get<MachinesConfig>('/api/machines/config');

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-2 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-mono break-all text-foreground/85">{children}</dd>
    </div>
  );
}

interface Ctx {
  config: MachinesConfig | null;
  authed: boolean;
  busy: boolean;
  editing: string | null;
  setEditing: (id: string | null) => void;
  attach: (e: MachineEdit, done: string) => Promise<boolean>;
  edit: (e: Exclude<PluginsEdit, { action: 'rescan' }>, done: string) => Promise<boolean>;
}

function MachineCard({ m, ctx }: { m: MachineView; ctx: Ctx }) {
  const now = useNow();
  const kind: MachineKind = kindOf(ctx.config, m.id);
  const busyLanes = m.lanes.filter((l) => l.state !== 'idle').length;
  const editing = ctx.editing === m.id;
  const actions = ctx.authed && !editing && kind.kind !== 'unknown' && (
    <>
      <Button size="sm" variant="outline" disabled={ctx.busy} onClick={() => ctx.setEditing(m.id)} aria-label={`Edit ${m.id}`}><Pencil />Edit</Button>
      <Confirm title={`Remove ${m.id}?`} action="Remove"
        description={<>It is removed and stops taking jobs at once. Refused while a job runs there or waits for an answer in a pane there.</>}
        onConfirm={() => void ctx.edit({ action: 'remove', role: 'machine-source', name: m.id, version: ctx.config!.version }, `Removed ${m.id}`)}>
        <Button size="sm" variant="outline" disabled={ctx.busy} aria-label={`Remove ${m.id}`}><Trash2 />Remove</Button>
      </Confirm>
    </>
  );
  return (
    <Panel title={m.label || m.id} icon={Server} bodyClassName="space-y-4"
      action={<StatusBadge status={m.online ? 'online' : 'offline'} />}>
      <div className="grid grid-cols-3 gap-3 text-sm">
        <div><div className="text-[11px] text-muted-foreground">max lanes</div><div className="num text-lg font-semibold">{m.maxLanes}</div></div>
        <div><div className="text-[11px] text-muted-foreground">open</div><div className="num text-lg font-semibold">{m.lanes.length}</div></div>
        <div><div className="text-[11px] text-muted-foreground">busy</div><div className="num text-lg font-semibold">{busyLanes}</div></div>
      </div>
      <dl className="grid gap-1.5">
        <Fact label="id">{m.id}{kind.kind === 'local' && <span className="ml-1.5 font-sans text-muted-foreground">this machine</span>}</Fact>
        <Fact label="runs">{m.executors.length ? m.executors.join(', ') : '—'}</Fact>
        {m.ssh && <Fact label="ssh target">{m.ssh}</Fact>}
        {m.docker && <Fact label="container (docker exec)">{m.docker}</Fact>}
        {m.herdr && <Fact label="herdr">{m.herdr.bin}</Fact>}
        {m.herdr && <Fact label="herdr session">{m.herdr.session}</Fact>}
        {m.client && <Fact label="connection">client, over its reverse tunnel</Fact>}
        {clientReleaseText(m.client) && <Fact label="client release">{clientReleaseText(m.client)}</Fact>}
      </dl>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      {editing && kind.kind === 'attached' && ctx.config && (
        <EditMachineForm machine={kind} config={ctx.config} busy={ctx.busy} send={ctx.edit} onDone={() => ctx.setEditing(null)} />
      )}
      {editing && kind.kind === 'local' && ctx.config && (
        <LocalMachineForm machine={kind} config={ctx.config} busy={ctx.busy} send={ctx.edit} onDone={() => ctx.setEditing(null)} />
      )}
      <div className="flex flex-wrap gap-x-2 gap-y-4">
        {orderReadings(m.usage).map((r) => <ReadingGauge key={readingKey(r)} r={r} now={now} showSource />)}
        {!m.usage.length && <div className="text-xs text-muted-foreground/70">no usage readings for this machine</div>}
      </div>
    </Panel>
  );
}

export function Machines() {
  const machines = useHopper((s) => s.machines);
  const authed = useCanAdmin();
  const [config, setConfig] = useState<MachinesConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState<false | 'this' | 'ssh'>(false);
  const [defaulting, setDefaulting] = useState(false);
  const open = useRef(false);
  useEffect(() => { open.current = adding !== false || defaulting || editing !== null; }, [adding, defaulting, editing]);

  const load = useCallback(() => fetchConfig().then(setConfig, (e: Error) => { toast.error(e.message); }), []);
  useEffect(() => {
    void load();
    const t = setInterval(() => { if (!open.current) void load(); }, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const run = async (call: () => Promise<void>, done: string): Promise<boolean> => {
    setBusy(true);
    try {
      await call();
      toast.success(done);
      await refreshLive().catch(() => {});
      return true;
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false });
      toast.error((e as Error).message);
      if (/changed since it was read/.test((e as Error).message)) await load();
      return false;
    } finally {
      setBusy(false);
    }
  };
  const ctx: Ctx = {
    config, authed, busy, editing, setEditing,
    attach: (e, done) => run(async () => setConfig(await post<MachinesConfig>('/ui/api/machines', e)), done),
    edit: (e, done) => run(async () => { await post('/ui/api/plugins', e); await load(); }, done),
  };
  const saveDefaults = (e: MachineDefaultsEdit, done: string) => run(async () => setConfig(await post<MachinesConfig>('/ui/api/machines/defaults', e)), done);
  const d = config?.defaults;

  return (
    <div className="space-y-3">
      {authed && config && d && (defaulting
        ? <Panel title="Machine defaults" icon={SlidersHorizontal}><MachineDefaultsForm config={config} busy={busy} send={saveDefaults} onDone={() => setDefaulting(false)} /></Panel>
        : !adding && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="text-xs text-muted-foreground">
              a new machine: {d.lanes} lane{d.lanes === 1 ? '' : 's'}, runs {d.executors.length ? d.executors.join(', ') : 'nothing'}
            </span>
            <Button size="lg" variant="outline" onClick={() => setDefaulting(true)}><SlidersHorizontal />Defaults</Button>
            {!hasThisMachine(config) && <Button size="lg" onClick={() => setAdding('this')}><Plus />Add this machine</Button>}
            <Button size="lg" variant={hasThisMachine(config) ? 'default' : 'outline'} onClick={() => setAdding('ssh')}><Plus />Add machine over ssh</Button>
          </div>
        ))}
      {authed && config && adding === 'this' && !defaulting && (
        <Panel title="Add this machine" icon={Plus}><AddThisMachineForm config={config} busy={busy} send={ctx.attach} onDone={() => setAdding(false)} /></Panel>
      )}
      {authed && config && adding === 'ssh' && !defaulting && (
        <Panel title="Attach a machine over ssh" icon={Plus}><AddMachineForm config={config} busy={busy} send={ctx.attach} onDone={() => setAdding(false)} /></Panel>
      )}
      {config?.error && <div className="rounded-md border border-bad/40 p-3 text-xs break-words text-bad">{config.error}</div>}
      {machines.length
        ? <div className="grid gap-3 lg:grid-cols-2">{machines.map((m) => <MachineCard key={m.id} m={m} ctx={ctx} />)}</div>
        : <Panel title="Machines" icon={Server}><Empty>no machines: every job is held. Add this machine to run them here.</Empty></Panel>}
    </div>
  );
}
