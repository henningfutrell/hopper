// Draining a machine on its Machines card (issue #1511, design.md "Draining a machine"): an admin drains it before
// maintenance — no new job is placed on it, the jobs on it run to their end — and undrains it after
// (POST /ui/api/machines/drain). While it is drained the card says so, by whom and since when, and how many jobs are still on it.
// Issue #2499: the drain names its reason and the hours until it ends by itself; the card shows both.
import { useState } from 'react';
import { Ban, Play } from 'lucide-react';
import { Confirm } from '@/components/confirm';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ago, countdown } from '@/model/format';
import type { MachineView } from '@/model/wire';
import { act } from '@/store';

/** The jobs still on the machine: its lanes busy or draining. */
const jobsOn = (m: MachineView): number => m.lanes.filter((l) => l.state !== 'idle').length;

/** What the card says while the machine is drained; null when it is not. */
export function MachineDrainNotice({ m, now }: { m: MachineView; now: number }) {
  if (!m.drained) return null;
  const left = jobsOn(m);
  return (
    <p role="status" data-slot="drained" className="text-sm text-warn">
      Drained by {m.drained.person} {ago(m.drained.at, now)}{m.drained.reason ? <> for “{m.drained.reason}”</> : null}: takes no new job.{' '}
      {left === 0 ? 'No job is on it now.' : left === 1 ? 'The 1 job still on it runs to its end.' : `The ${left} jobs still on it run to their end.`} Undrain it to take new jobs again{m.drained.until ? <>, or it ends by itself {countdown(m.drained.until, now)}</> : null}.
    </p>
  );
}

/** Drain (after a confirm) or undrain the machine. */
export function MachineDrainButton({ m }: { m: MachineView }) {
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [hours, setHours] = useState('24');
  const hoursOk = /^\d+$/.test(hours) && Number(hours) >= 1 && Number(hours) <= 720;
  const send = async (drained: boolean) => {
    setBusy(true);
    try {
      const body = drained ? { machineId: m.id, drained, reason: reason.trim(), hours: Number(hours) } : { machineId: m.id, drained };
      await act('/ui/api/machines/drain', body, drained ? `Drained ${m.id}` : `Undrained ${m.id}`);
    } finally {
      setBusy(false);
    }
  };
  if (m.drained) {
    return <Button size="sm" variant="outline" disabled={busy} onClick={() => void send(false)} aria-label={`Undrain ${m.id}`}><Play />Undrain</Button>;
  }
  return (
    <Confirm title={`Drain ${m.id}?`} action="Drain"
      description={<>No new job is placed on it until you undrain it, or until it ends by itself. The jobs on it now run to their end. Use it before maintenance.</>}
      fields={
        <div className="grid gap-2 text-sm">
          <label className="grid gap-1">Reason<Input name="drain-reason" value={reason} maxLength={300} placeholder="seat rebuild" onChange={(e) => setReason(e.target.value)} /></label>
          <label className="grid gap-1">Ends by itself after (hours, 1 to 720)<Input name="drain-hours" inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} /></label>
        </div>
      }
      disabled={!reason.trim() || !hoursOk}
      onConfirm={() => void send(true)}>
      <Button size="sm" variant="outline" disabled={busy} aria-label={`Drain ${m.id}`}><Ban />Drain</Button>
    </Confirm>
  );
}
