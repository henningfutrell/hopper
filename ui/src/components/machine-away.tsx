// A machine whose link dropped under a running job (issue #752, design.md "Link-lost hold"): its card says since when
// it is out of reach and how many jobs are held for it, in place of looking idle. Gone once the link is back.
import { Unplug } from 'lucide-react';
import { useNow } from '@/hooks/use-now';
import { ago, clock } from '@/model/format';
import { useHopper } from '@/store';

export function MachineAway({ machine }: { machine: string }) {
  const now = useNow();
  const jobs = useHopper((s) => s.jobs);
  const held = Object.values(jobs).filter((j) => j.status === 'running' && j.linkLost?.machine === machine);
  if (!held.length) return null;
  const since = held.map((j) => j.linkLost!.since).sort()[0]!;
  const failsAt = held.map((j) => j.linkLost!.failsAt).sort()[0]!;
  return (
    <div data-machine-away={machine} className="flex items-center gap-1.5 text-sm text-warn" title={`the link to machine ${machine} is down since ${since}`}>
      <Unplug className="size-4 shrink-0" />
      <span>out of reach since {clock(since)} ({ago(since, now)}), {held.length} {held.length === 1 ? 'job' : 'jobs'} held until {clock(failsAt)}</span>
    </div>
  );
}
