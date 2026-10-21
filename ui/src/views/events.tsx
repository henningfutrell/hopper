// The event stream, live, filterable by type or subject, as a log in a code block (issue #1169): one line per event, its
// seq, time, type and subject; an event about a job links to its job view. A long page (issue #2353): 40 lines to a page,
// newest first, and the header with the filter stays in view; Copy takes every event the filter shows.
import { ListTree } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { Input } from '@/components/ui/input';
import { CodeBlockLine } from '@/components/ui/code-block';
import { EventText, eventLineText } from '@/components/event-line';
import { LogBlock } from '@/components/log-block';
import { Pager, usePaged } from '@/components/pager';
import { subjectOf } from '@/model/board';
import { ROWS_PER_PAGE } from '@/model/page-prefs';
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
  const page = usePaged(shown, ROWS_PER_PAGE, f);
  return (
    <Panel title="Event stream" icon={ListTree} count={shown.length} sticky
      action={<Input data-slot="events-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter by type, job or lane" className="h-7 w-44 text-xs sm:w-60" />}>
      {shown.length ? (
        <div className="space-y-2">
          <LogBlock title="Events, newest first" copy={shown.map((e) => eventLineText(e, nameOf, machines)).join('\n')} contentClassName="text-xs">
            {page.shown.map((e) => (
              <CodeBlockLine key={e.seq} data-event-seq={e.seq}>
                <span className="num text-muted-foreground/60">#{e.seq}</span> <EventText e={e} nameOf={nameOf} machines={machines} />
              </CodeBlockLine>
            ))}
          </LogBlock>
          <Pager p={page} onPage={page.setPage} />
        </div>
      ) : <Empty>no events</Empty>}
    </Panel>
  );
}
