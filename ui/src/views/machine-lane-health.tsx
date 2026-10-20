// A machine's unhealthy lanes on its Machines card (issue #2234): which lane, why it takes no new job, the last start error,
// and when a job is placed there again to try it.
import { unhealthyLaneLines } from '@/model/lane-health';
import type { MachineView } from '@/model/wire';

/** What the card says while one of its lanes is unhealthy; null when none is. */
export function UnhealthyLanesNotice({ m, now }: { m: MachineView; now: number }) {
  const lines = unhealthyLaneLines(m, now);
  if (lines.length === 0) return null;
  return (
    <div role="alert" data-slot="unhealthy-lanes" className="grid gap-1.5 text-sm">
      {lines.map((l) => (
        <div key={l.lane} className="grid gap-1">
          <p className="text-warn">Lane {l.lane} is unhealthy: {l.text}.</p>
          <code className="rounded-md border bg-muted/40 p-2 font-mono text-xs break-all">{l.error}</code>
        </div>
      ))}
    </div>
  );
}
