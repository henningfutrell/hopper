// Machines: what each can run, its lanes, and the usage budgets that cap them.
import { Server } from 'lucide-react';
import { Gauge } from '@/charts/gauge';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { useNow } from '@/hooks/use-now';
import { countdown } from '@/model/format';
import { useHopper } from '@/store';

export function Machines() {
  const machines = useHopper((s) => s.machines);
  const now = useNow();
  if (!machines.length) return <Panel title="Machines" icon={Server}><Empty>no machines: every job is held</Empty></Panel>;
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {machines.map((m) => (
        <Panel key={m.id} title={m.label || m.id} icon={Server} action={<StatusBadge status={m.online ? 'online' : 'offline'} />} bodyClassName="space-y-4">
          <div className="grid grid-cols-3 gap-3 text-sm">
            <div><div className="text-[11px] text-muted-foreground">max lanes</div><div className="num text-lg font-semibold">{m.maxLanes}</div></div>
            <div><div className="text-[11px] text-muted-foreground">open</div><div className="num text-lg font-semibold">{m.lanes.length}</div></div>
            <div><div className="text-[11px] text-muted-foreground">busy</div><div className="num text-lg font-semibold">{m.lanes.filter((l) => l.state !== 'idle').length}</div></div>
          </div>
          <div className="text-xs text-muted-foreground">id <code className="font-mono text-foreground/80">{m.id}</code> · runs {m.executors.map((e) => <code key={e} className="mr-1 font-mono text-foreground/80">{e}</code>)}</div>
          <div className="flex flex-wrap gap-6">
            {m.usage.map((r) => (
              <div key={r.source} className="flex flex-col items-center gap-0.5">
                <Gauge fraction={r.limit > 0 ? r.used / r.limit : 0} label={r.source} sub={`${r.used}/${r.limit} ${r.unit}`} />
                <div className="font-mono text-xs">{r.source}</div>
                {r.resetsAt && <div className="num text-[11px] text-muted-foreground">resets {countdown(r.resetsAt, now)}</div>}
              </div>
            ))}
            {!m.usage.length && <div className="text-xs text-muted-foreground/70">no usage readings for this machine</div>}
          </div>
        </Panel>
      ))}
    </div>
  );
}
