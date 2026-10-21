// The sandbox host on a Machines card (issue #2272, design.md "The sandbox host"): a machine of the sandbox host says its
// place in it and how many sandboxes run there now (its open sandbox runs, GET /api/sandboxes). An admin adds a machine
// with no coding lanes to the sandbox host, last, or takes it out (POST /ui/api/machines/sandbox-host). The order, and
// `local` (beside the hopper), are set with `hopper machine sandbox-host`.
import { useState } from 'react';
import { Box } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { MachineView, SandboxesView } from '@/model/wire';
import { act, useHopper } from '@/store';

/** The sandboxes that run on the machine now: its sandbox runs not ended. */
export const liveSandboxes = (boxes: SandboxesView | null, machineId: string): number =>
  boxes?.runs.filter((r) => r.machine === machineId && r.endedAt === undefined).length ?? 0;

/** What the card says of a machine of the sandbox host; null for any other machine. */
export function SandboxHostNotice({ m, boxes }: { m: MachineView; boxes: SandboxesView | null }) {
  if (m.sandboxHost === undefined) return null;
  const n = liveSandboxes(boxes, m.id);
  return (
    <p role="status" data-slot="sandbox-host" className="text-sm text-muted-foreground">
      {m.sandboxHost === 1 ? 'The sandbox host' : `Sandbox host, place ${m.sandboxHost}`}: sandboxes start only here{m.sandboxHost === 1 ? '' : ' when the hosts before it are offline'}.{' '}
      {n === 0 ? 'No sandbox runs here now.' : n === 1 ? '1 sandbox runs here now.' : `${n} sandboxes run here now.`}
    </p>
  );
}

/** Add the machine to the sandbox host, last, or take it out. Only a machine with no coding lanes, and not one away. */
export function SandboxHostButton({ m }: { m: MachineView }) {
  const hosts = useHopper((s) => s.sandboxHost) ?? [];
  const [busy, setBusy] = useState(false);
  const on = hosts.includes(m.id);
  if (!on && m.maxLanes > 0) return null;
  const send = async () => {
    setBusy(true);
    try {
      await act('/ui/api/machines/sandbox-host', { hosts: on ? hosts.filter((h) => h !== m.id) : [...hosts, m.id] }, on ? `${m.id} is no sandbox host now` : `${m.id} is a sandbox host now`);
    } finally {
      setBusy(false);
    }
  };
  return <Button size="sm" variant="outline" disabled={busy} onClick={() => void send()} aria-label={on ? `Stop ${m.id} as the sandbox host` : `Use ${m.id} as the sandbox host`}><Box />{on ? 'Stop as sandbox host' : 'Use as sandbox host'}</Button>;
}
