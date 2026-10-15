// The event stream, live, filterable by type or subject, as a log in a code block (issue #1169): one line per event, its
// seq, time, type and subject; an event about a job links to its job view.
import { ListTree } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { Input } from '@/components/ui/input';
import { CodeBlockLine } from '@/components/ui/code-block';
import { EventText, eventLineText } from '@/components/event-line';
import { LogBlock } from '@/components/log-block';
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
      action={<Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter by type, job or lane" className="h-7 w-44 text-xs sm:w-60" />}>
      {shown.length ? (
        <LogBlock title="Events, newest first" copy={shown.map((e) => eventLineText(e, nameOf, machines)).join('\n')} contentClassName="text-xs">
          {shown.map((e) => (
            <CodeBlockLine key={e.seq} data-event-seq={e.seq}>
              <span className="num text-muted-foreground/60">#{e.seq}</span> <EventText e={e} nameOf={nameOf} machines={machines} />
            </CodeBlockLine>
          ))}
        </LogBlock>
      ) : <Empty>no events</Empty>}
    </Panel>
  );
}
