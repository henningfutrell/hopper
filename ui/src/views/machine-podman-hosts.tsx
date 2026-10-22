// The Podman hosts on Machines (issue #2272, design.md "Podman hosts"): each one the user set up (Settings → Podman
// hosts) shows whether it is the sandbox host and its place there, how many sandboxes run there now (its open sandbox
// runs, GET /api/sandboxes), and its CPU and memory now, or why it is offline (GET /api/podman-hosts/status, read from
// libpod /info over its ssh stream). The numbers are there to size the host from real use.
import { useEffect, useState } from 'react';
import { Container } from 'lucide-react';
import { Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { get } from '@/lib/api';
import type { PodmanHostsStatusView, PodmanHostStatus, SandboxesView } from '@/model/wire';
import { useHopper } from '@/store';
import { MachinesSection } from './machine-list';
import { liveSandboxes } from './machine-sandbox-host';

const REFRESH_MS = 15000;
const GiB = 1024 ** 3;

const placeText = (place: number): string => (place === 0 ? 'Not the sandbox host' : place === 1 ? 'The sandbox host' : `Sandbox host, place ${place}`);
const runsText = (n: number): string => (n === 0 ? 'No sandbox runs here now.' : n === 1 ? '1 sandbox runs here now.' : `${n} sandboxes run here now.`);

function PodmanHostCard({ h, place, live }: { h: PodmanHostStatus; place: number; live: number }) {
  const cpu = h.cpus === undefined ? '—' : h.cpuBusyFrac === undefined ? `${h.cpus} CPUs` : `${Math.round(h.cpuBusyFrac * 100)}% of ${h.cpus} CPUs`;
  const memory = h.memTotalBytes === undefined ? '—' : `${((h.memUsedBytes ?? 0) / GiB).toFixed(1)} of ${(h.memTotalBytes / GiB).toFixed(1)} GiB`;
  return (
    <div data-slot="podman-host-card" data-host={h.name}>
      <Panel title={h.name} icon={Container} bodyClassName="space-y-3"
        action={<div className="flex items-center gap-1.5">
          {place > 0 && <StatusBadge status="sandbox-host" label={place === 1 ? 'sandbox host' : `sandbox host ${place}`} tone="ok" />}
          <StatusBadge status={h.problem ? 'offline' : 'online'} tone={h.problem ? 'bad' : 'ok'} />
        </div>}>
        <p className="text-sm text-muted-foreground">{placeText(place)}. {runsText(live)}</p>
        {h.problem
          ? <p role="alert" className="text-sm break-words text-bad">{place > 0 ? 'sandbox host ' : ''}{h.name} is offline: {h.problem}</p>
          : (
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div><div className="text-[11px] text-muted-foreground">CPU</div><div data-slot="podman-host-cpu" className="num font-semibold">{cpu}</div></div>
              <div><div className="text-[11px] text-muted-foreground">memory in use</div><div data-slot="podman-host-memory" className="num font-semibold">{memory}</div></div>
            </div>
          )}
      </Panel>
    </div>
  );
}

/** The Podman hosts section of Machines; nothing while the user has none. */
export function MachinePodmanHosts({ boxes }: { boxes: SandboxesView | null }) {
  const hosts = useHopper((s) => s.sandboxHost) ?? [];
  const [view, setView] = useState<PodmanHostsStatusView | null>(null);
  useEffect(() => {
    const load = () => { get<PodmanHostsStatusView>('/api/podman-hosts/status').then(setView, () => setView(null)); };
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, []);
  if (!view?.hosts.length) return null;
  return (
    <MachinesSection id="podman-hosts" title="Podman hosts" count={view.hosts.length}>
      <div className="grid gap-3 lg:grid-cols-2">
        {view.hosts.map((h) => <PodmanHostCard key={h.name} h={h} place={hosts.indexOf(h.name) + 1} live={liveSandboxes(boxes, h.name)} />)}
      </div>
    </MachinesSection>
  );
}
