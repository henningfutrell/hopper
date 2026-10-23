// Machines: what each can run, its lanes (and those it keeps for jobs pinned to it, issue #372), and
// the usage budgets that cap them. Logged in, Add machine shows
// one line that joins a computer (issue #308, machine-join.tsx; a sandbox never joins, issue #1349); or add this
// machine — no ssh target, its name and herdr session (issue #260); an ssh target that is this machine is
// added so too, and in a container there is no adding it (issue #275) — or attach a machine over ssh (POST /ui/api/machines), edit (its name and how it is reached too, issue #205) or remove
// any machine — each a machine-source instance, edited like every plugin instance (POST /ui/api/plugins,
// issue #74) — each applied by the
// daemon without a restart (design.md "Machines from the UI", issue #18). The machine defaults — what a
// new machine starts with — are edited here too (POST /ui/api/machines/defaults, issue #142). Below the machines, the
// priority lanes: every lane's reliability and why it is or is not one (issue #535, priority-lanes.tsx); and each machine's
// blast radius, the gate and the actor machines (issue #542, blast-radius.tsx). Each card says its CPU and memory now,
// draws its CPU over the last day, and opens its resource graph (issue #560, machine-resources.tsx). Each machine's lane
// recommendation and its lane tuning settings sit under the machines (issue #688, lane-tuning.tsx). A sandbox box an older
// build launched that the hopper could not burn is shown with the reason (issues #603, #1349, GET /api/sandboxes). A machine whose link dropped under a running
// job says since when it is out of reach and that the job is held (issue #752, machine-away.tsx). Each card
// says the hopper's own disk use there, against the disk budget set under the machines (issue #1120, disk-budget.tsx), and the
// leftovers there the sweep does not judge, each for a person to keep or remove (issue #1116, machine-leftovers.tsx).
// A machine whose job user holds infra credentials is not ready: their names and the guided fix to a dedicated job user (issues #1128 part 7, #1248).
// Cards or List, and sections a person collapses, each remembered per browser (issue #2352, machine-list.tsx; the card itself, machine-card.tsx).
// Below the machines, each Podman host: its sandbox host place, live sandboxes, CPU and memory or why it is offline (issue #2272, machine-podman-hosts.tsx).
import { Box, Plus, Server, SlidersHorizontal } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Empty, Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { useMachinesMode } from '@/hooks/use-machines-layout';
import { get, post, SessionRejected } from '@/lib/api';
import { mayAddThisMachine } from '@/model/machines';
import type { CleanupProblem, MachineDefaultsEdit, MachinesConfig, SandboxesView } from '@/model/wire';
import { refreshLive, useHopper } from '@/store';
import { AddMachineForm, AddThisMachineForm, MachineDefaultsForm } from './machine-forms';
import { useCanAdmin } from '@/store/selectors';
import { JoinMachineForm } from './machine-join';
import { PriorityLanesPanel } from './priority-lanes';
import { BlastRadiusPanel } from './blast-radius';
import { CredentialCheckPanel } from './machine-credentials';
import { JobCostsPanel } from './job-costs';
import { LaneTuningPanel } from './lane-tuning';
import { useCpuSparks } from './machine-resources';
import { DiskBudgetPanel } from './disk-budget'; import { DiskDefaultsPanel } from './disk-defaults';
import { SandboxPlaygroundPanel } from './sandbox-playground';
import { MachineCard, type Ctx } from './machine-card';
import { MachineList, MachinesModeToggle, MachinesSection } from './machine-list';
import { MachinePodmanHosts } from './machine-podman-hosts';

const REFRESH_MS = 15000;
const fetchConfig = () => get<MachinesConfig>('/api/machines/config');

/** The sandbox boxes an older build launched that the hopper could not burn (issues #603, #1349): each with the reason, until it goes. */
function CleanupProblems({ problems }: { problems: CleanupProblem[] }) {
  return (
    <Panel title="Sandbox boxes not removed" icon={Box}>
      <div role="alert" className="grid gap-2 text-sm">
        <p className="text-xs text-muted-foreground">A sandbox never joins as a machine, so the hopper burns each box an older build launched. It could not remove these boxes. It tries again every few seconds. To remove one by hand: <code className="font-mono">podman rm -f &lt;box&gt;</code>, then <code className="font-mono">podman volume rm &lt;box&gt;-home</code>.</p>
        <ul className="grid gap-1.5">
          {problems.map((p) => (
            <li key={p.container} className="text-xs break-words">
              <span className="font-mono font-medium text-foreground">{p.container}</span>
              <span className="text-destructive">: {p.reason}</span>
              <span className="text-muted-foreground"> (since {new Date(p.at).toLocaleTimeString()})</span>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

export function Machines() {
  const machines = useHopper((s) => s.machines);
  const mode = useMachinesMode();
  const authed = useCanAdmin();
  const [config, setConfig] = useState<MachinesConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState<false | 'join' | 'this' | 'ssh'>(false);
  const [defaulting, setDefaulting] = useState(false);
  const open = useRef(false);
  useEffect(() => { open.current = adding !== false || defaulting || editing !== null; }, [adding, defaulting, editing]);

  const [boxes, setBoxes] = useState<SandboxesView | null>(null);
  const cleanup: CleanupProblem[] = boxes?.problems ?? [];
  const load = useCallback(() => Promise.all([
    fetchConfig().then(setConfig, (e: Error) => { toast.error(e.message); }),
    get<SandboxesView>('/api/sandboxes').then(setBoxes, () => setBoxes(null)),
  ]), []);
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
  const sparks = useCpuSparks();
  const ctx: Ctx = {
    config, authed, busy, editing, setEditing, sparks, boxes,
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
            {mayAddThisMachine(config) && <Button size="lg" variant="outline" onClick={() => setAdding('this')}><Plus />Add this machine</Button>}
            <Button size="lg" onClick={() => setAdding('join')}><Plus />Add machine</Button>
          </div>
        ))}
      {authed && config && adding === 'join' && !defaulting && (
        <Panel title="Add machine" icon={Plus}><JoinMachineForm onDone={() => setAdding(false)} onSsh={() => setAdding('ssh')} /></Panel>
      )}
      {authed && config && adding === 'this' && !defaulting && (
        <Panel title="Add this machine" icon={Plus}><AddThisMachineForm config={config} busy={busy} send={ctx.attach} onDone={() => setAdding(false)} /></Panel>
      )}
      {authed && config && adding === 'ssh' && !defaulting && (
        <Panel title="Attach a machine over ssh" icon={Plus}><AddMachineForm config={config} busy={busy} send={ctx.attach} onDone={() => setAdding(false)} /></Panel>
      )}
      {cleanup.length > 0 && <CleanupProblems problems={cleanup} />}
      {config?.error && <div className="rounded-md border border-bad/40 p-3 text-xs break-words text-bad">{config.error}</div>}
      <MachinesSection id="machines" title="Machines" count={machines.length} action={machines.length > 0 && <MachinesModeToggle />}>
        {!machines.length
          ? <Panel title="Machines" icon={Server}><Empty>no machines: every job is held. Add machine shows one line that joins a computer.</Empty></Panel>
          : mode === 'list'
            ? <MachineList machines={machines} ctx={ctx} />
            : <div data-slot="machine-cards" className="grid gap-3 lg:grid-cols-2">{machines.map((m) => <MachineCard key={m.id} m={m} ctx={ctx} />)}</div>}
      </MachinesSection>
      <MachinePodmanHosts boxes={boxes} />
      {authed && <MachinesSection id="sandboxes" title="Sandbox playground"><SandboxPlaygroundPanel /></MachinesSection>}
      {machines.length > 0 && (
        <MachinesSection id="budgets" title="Budgets and lane tuning"><DiskBudgetPanel /><DiskDefaultsPanel /><LaneTuningPanel /><JobCostsPanel /></MachinesSection>
      )}
      {machines.length > 0 && <MachinesSection id="lanes" title="Priority lanes and blast radius"><PriorityLanesPanel /><BlastRadiusPanel /></MachinesSection>}
      {authed && machines.length > 0 && <MachinesSection id="credentials" title="Credentials"><CredentialCheckPanel /></MachinesSection>}
    </div>
  );
}
