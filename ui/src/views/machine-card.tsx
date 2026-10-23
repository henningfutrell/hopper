// One machine's card on Machines (issue #2352 moved it out of machines.tsx): its badges, lanes, facts, alerts, actions,
// CPU sparkline and usage readings. The cards view shows it in a grid; the list view shows it under a row it expands.
import { Activity, Pencil, Server, SquareTerminal, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Confirm } from '@/components/confirm';
import { MachineAway } from '@/components/machine-away';
import { WindowsLinkProblem } from '@/components/windows-link';
import { ReadingGauge } from '@/components/reading';
import { Panel } from '@/components/panel';
import { StatusBadge, TEXT } from '@/components/status';
import { Button } from '@/components/ui/button';
import { useNow } from '@/hooks/use-now';
import { clientReleaseText, clientUpdateLine, diskText, herdrText, kindOf, ownedHerdrText, offNetwork, reservedText, templateText, workTreeText, workTreesText, type MachineKind } from '@/model/machines';
import { machineBadges, nodeText } from '@/model/machine-list';
import { resourcesText } from '@/model/machine-history';
import { cachesText, hopperDiskText, storageText } from '@/model/hopper-disk';
import { windowsLinkText } from '@/model/windows-link';
import { orderReadings, readingKey } from '@/model/usage';
import type { MachineEdit, MachinesConfig, MachineView, PluginsEdit, ResourceSeries, SandboxesView } from '@/model/wire';
import { allows } from '@/model/roles';
import { useHopper } from '@/store';
import { EditMachineForm, LocalMachineForm } from './machine-forms';
import { useCanAdmin } from '@/store/selectors';
import { CredentialCheck } from './machine-credentials';
import { CpuSparkline, MachineResourcesGraph } from './machine-resources';
import { MachineTerminal } from './machine-terminal';
import { MachineDrainButton, MachineDrainNotice } from './machine-drain';
import { SandboxHostButton, SandboxHostNotice } from './machine-sandbox-host';
import { UnhealthyLanesNotice } from './machine-lane-health';
import { MachineLeftovers } from './machine-leftovers';

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-2 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-mono break-all text-foreground/85">{children}</dd>
    </div>
  );
}

export interface Ctx {
  config: MachinesConfig | null;
  authed: boolean;
  busy: boolean;
  editing: string | null;
  setEditing: (id: string | null) => void;
  attach: (e: MachineEdit, done: string) => Promise<boolean>;
  edit: (e: Exclude<PluginsEdit, { action: 'rescan' }>, done: string) => Promise<boolean>;
  /** Every machine's CPU over the last day, for the sparklines (issue #560). */
  sparks: readonly ResourceSeries[];
  /** The user's sandbox runs (GET /api/sandboxes): how many run on a machine of the sandbox host now (issue #2272). */
  boxes: SandboxesView | null;
}

export function MachineCard({ m, ctx }: { m: MachineView; ctx: Ctx }) {
  const now = useNow();
  const kind: MachineKind = kindOf(ctx.config, m.id);
  const busyLanes = m.lanes.filter((l) => l.state !== 'idle').length;
  const updateLine = clientUpdateLine(m.client, window.location.origin);
  const editing = ctx.editing === m.id;
  const [graph, setGraph] = useState(false);
  const [terminal, setTerminal] = useState(false);
  const admin = useCanAdmin();
  const operator = useHopper((s) => allows(s.user, 'operator'));
  const res = resourcesText(m.resources);
  const off = offNetwork(m);
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
      action={<div className="flex items-center gap-1.5">{machineBadges(m, now).map((b) => <StatusBadge key={b.status} status={b.status} tone={b.tone} />)}</div>}>
      <MachineAway machine={m.id} />
      <div className="grid grid-cols-3 gap-3 text-sm">
        <div><div className="text-[11px] text-muted-foreground">max lanes</div><div className="num text-lg font-semibold">{m.maxLanes}</div></div>
        <div><div className="text-[11px] text-muted-foreground">open</div><div className="num text-lg font-semibold">{m.lanes.length}</div></div>
        <div><div className="text-[11px] text-muted-foreground">busy</div><div className="num text-lg font-semibold">{busyLanes}</div></div>
      </div>
      <dl className="grid gap-1.5">
        <Fact label="id">{m.id}{kind.kind === 'local' && <span className="ml-1.5 font-sans text-muted-foreground">this machine</span>}</Fact>
        <Fact label="runs">{m.executors.length ? m.executors.join(', ') : '—'}</Fact>
        {m.ssh && <Fact label="ssh target">{m.ssh}</Fact>}
        {m.containerImage && <Fact label="image (a sandbox box per command)">{m.containerImage}</Fact>}
        {m.herdr && <Fact label="herdr session">{m.herdr.session}</Fact>}
        {herdrText(m) && <Fact label="herdr"><span className={m.herdrProblem ? `font-semibold ${TEXT.warn}` : undefined}>{herdrText(m)}</span></Fact>}
        {ownedHerdrText(m) && <Fact label="hopper's herdr">{ownedHerdrText(m)}</Fact>}
        {m.client && <Fact label="connection">client, dialled in</Fact>}
        {templateText(m) && <Fact label="template">{templateText(m)}</Fact>}
        {clientReleaseText(m.client) && <Fact label="client release">{clientReleaseText(m.client)}</Fact>}
        {reservedText(m) && <Fact label="reserved lanes">{reservedText(m)}</Fact>}
        {res && <Fact label="CPU">{res.cpu}</Fact>}
        {res && <Fact label="memory">{res.memory}</Fact>}
        {m.resources?.windowsLink && <Fact label="Windows link"><span className={m.resources.windowsLink.ok ? undefined : `font-semibold ${TEXT.warn}`}>{windowsLinkText(m.resources.windowsLink)}</span></Fact>}
        {m.resources?.node && <Fact label="Node"><span className={m.resources.nodeFloor ? `font-semibold ${TEXT.warn}` : undefined}>{nodeText(m.resources)}</span></Fact>}
        {m.disk && <Fact label="disk (home)"><span className={m.disk.low ? `font-semibold ${TEXT.warn}` : undefined}>{diskText(m.disk)}</span></Fact>}
        {m.hopperDisk && <Fact label="hopper's disk use"><span className={m.hopperDisk.over ? `font-semibold ${TEXT.warn}` : undefined}>{hopperDiskText(m.hopperDisk)}</span></Fact>}
        {cachesText(m.hopperDisk?.caches) && <Fact label="caches">{cachesText(m.hopperDisk?.caches)}</Fact>}
        {storageText(m.hopperDisk?.storage) && <Fact label="container storage">{storageText(m.hopperDisk?.storage)}</Fact>}
        {workTreeText(m) && <Fact label="work tree">{workTreeText(m)}</Fact>}
        {workTreesText(m) && <Fact label="work trees per repository">{workTreesText(m)}</Fact>}
      </dl>
      {updateLine && (
        <div role="alert" className="grid gap-1.5 text-sm">
          <p className="text-destructive">Its client cannot be updated from here: {m.client?.update?.problem}.</p>
          <p className="text-xs text-muted-foreground">Run this in a terminal on that computer to reinstall it: it stays the same machine, and jobs running there keep going. On a sandbox box, remove <code>~/.local/lib/hopper-client</code> in the box and restart it.</p>
          <div className="flex flex-wrap items-start gap-2 text-xs">
            <code className="min-w-0 flex-1 rounded-md border bg-muted/40 p-2 font-mono break-all">{updateLine}</code>
            <Button type="button" size="sm" variant="outline" className="min-h-9" onClick={() => void navigator.clipboard?.writeText(updateLine).then(() => toast.success('Copied'), () => toast.error('Clipboard blocked'))}>Copy</Button>
          </div>
        </div>
      )}
      {m.template?.waiting && (
        <p role="alert" className="text-sm text-warn">Takes no job: {m.template.waiting}. Its jobs wait for another machine until a person approves the template on <a href="#approvals/access-requests" className="underline">Access requests</a>.</p>
      )}
      {m.herdrProblem && (
        <p role="alert" className="text-sm text-destructive">Takes no new job: {m.herdrProblem}. Its jobs wait for another machine.</p>
      )}
      <MachineDrainNotice m={m} now={now} />
      <SandboxHostNotice m={m} boxes={ctx.boxes} />
      <UnhealthyLanesNotice m={m} now={now} />
      <CredentialCheck m={m} authed={ctx.authed} busy={ctx.busy} />
      <MachineLeftovers m={m} canAct={ctx.authed && operator} />
      {m.resources?.windowsLink && <WindowsLinkProblem link={m.resources.windowsLink} />}
      {m.workTreeProblem && (
        <p role="alert" className="text-sm text-destructive">Takes no new job: {m.workTreeProblem}. Its jobs wait for another machine; set its work tree with Edit.</p>
      )}
      {off && (
        <div role="alert" className="grid gap-1.5 text-sm">
          <p className="text-destructive">Off-network, takes no new job: {off.problem}. Its jobs wait for another machine.</p>
          {off.fix && (
            <>
              <p className="text-xs text-muted-foreground">Run this on the computer its container runs on, to join it to the hopper's network (Docker: <code>docker network connect</code>). Or set HOPPER_PUBLIC_URL to an address it reaches.</p>
              <div className="flex flex-wrap items-start gap-2 text-xs">
                <code className="min-w-0 flex-1 rounded-md border bg-muted/40 p-2 font-mono break-all">{off.fix}</code>
                <Button type="button" size="sm" variant="outline" className="min-h-9" aria-label={`Copy the network fix for ${m.id}`} onClick={() => void navigator.clipboard?.writeText(off.fix!).then(() => toast.success('Copied'), () => toast.error('Clipboard blocked'))}>Copy</Button>
              </div>
            </>
          )}
        </div>
      )}
      {m.hopperUrl && <p className="text-xs text-muted-foreground">Its jobs reach the hopper at <code>{m.hopperUrl}</code>.</p>}
      <CpuSparkline series={ctx.sparks} machineId={m.id} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" aria-expanded={graph} onClick={() => setGraph((g) => !g)}><Activity />{graph ? 'Hide the graph' : 'Resources, lanes and usage'}</Button>
        {admin && m.online && m.herdr && !terminal && <Button size="sm" variant="outline" onClick={() => setTerminal(true)}><SquareTerminal />Terminal</Button>}
        {admin && ctx.authed && <MachineDrainButton m={m} />}
        {admin && ctx.authed && <SandboxHostButton m={m} />}
        {actions}
      </div>
      {graph && <MachineResourcesGraph machineId={m.id} />}
      {terminal && <MachineTerminal machineId={m.id} onClose={() => setTerminal(false)} />}
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

