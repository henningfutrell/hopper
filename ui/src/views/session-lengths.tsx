// Settings → Sign-in, how long a session lasts (issue #439): the idle timeout and the maximum, in hours, saved
// together through the sign-in settings change; the daemon checks them and the refusal is shown as a toast. A
// change applies to every session there is. Keyed by the saved values, so a save starts it from them again.
import { Clock } from 'lucide-react';
import { useState } from 'react';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { SessionLengths } from '@/model/wire';

/** Hours as people read them: whole days when they are, else hours. */
export const lengthText = (hours: number): string =>
  (hours >= 24 && hours % 24 === 0 ? `${hours / 24} day${hours === 24 ? '' : 's'}` : `${hours} hour${hours === 1 ? '' : 's'}`);

export function SessionLengthsPanel({ lengths, busy, onSave }: { lengths: SessionLengths; busy: boolean; onSave: (l: SessionLengths) => void }) {
  const [idle, setIdle] = useState(String(lengths.idleHours));
  const [max, setMax] = useState(String(lengths.maxHours));
  const changed = Number(idle) !== lengths.idleHours || Number(max) !== lengths.maxHours;
  return (
    <Panel title="Sessions" icon={Clock}>
      <div data-section="sessions" className="space-y-2 text-sm">
        <p className="text-muted-foreground">
          A session ends after {lengthText(lengths.idleHours)} without use, and {lengthText(lengths.maxHours)} after signing in however much it is used. Then the hopper asks to sign in again, and comes back to the same page. A change applies to everyone signed in now.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1"><span className="text-xs text-muted-foreground">Idle timeout (hours)</span>
            <Input type="number" min="0" step="any" className="h-8 w-28" aria-label="Idle timeout in hours" value={idle} disabled={busy} onChange={(e) => setIdle(e.target.value)} /></label>
          <label className="grid gap-1"><span className="text-xs text-muted-foreground">At most (hours)</span>
            <Input type="number" min="0" step="any" className="h-8 w-28" aria-label="Longest session in hours" value={max} disabled={busy} onChange={(e) => setMax(e.target.value)} /></label>
          <Button size="sm" disabled={busy || !changed} onClick={() => onSave({ idleHours: Number(idle), maxHours: Number(max) })}>Save</Button>
        </div>
      </div>
    </Panel>
  );
}
