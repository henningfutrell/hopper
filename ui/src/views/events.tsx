// The event stream, live, filterable by type or subject.
import { ListTree } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { Input } from '@/components/ui/input';
import { EventLine } from '@/components/event-line';
import { subjectOf } from '@/model/board';
import { Empty, Panel } from '@/components/panel';
import { useHopper } from '@/store';
import { useJobName } from '@/store/selectors';

export function Events() {
  const events = useHopper((s) => s.events);
  const nameOf = useJobName();
  const machines = useHopper((s) => s.machines);
  const [filter, setFilter] = useState('');
  const f = useDeferredValue(filter.trim().toLowerCase());
  const shown = f ? events.filter((e) => e.type.includes(f) || subjectOf(e, nameOf, machines).toLowerCase().includes(f)) : events;
  return (
    <Panel title="Event stream" icon={ListTree} count={shown.length}
      action={<Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter by type, job or lane" className="h-7 w-44 text-xs sm:w-60" />}
      bodyClassName="space-y-1 font-mono">
      {shown.length ? shown.map((e) => (
        <div key={e.seq} className="flex items-baseline gap-2">
          <span className="num w-12 shrink-0 text-right text-[11px] text-muted-foreground/60">#{e.seq}</span>
          <EventLine e={e} nameOf={nameOf} machines={machines} className="flex-1" />
        </div>
      )) : <Empty>no events</Empty>}
    </Panel>
  );
}
