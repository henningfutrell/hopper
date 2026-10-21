// The event stream, live, as a table (issue #2375): time, job, event type and message, one row per event; an event about a
// job links to its job view, and a row opens its detail — the ids and the data, in monospace. Filter chips by event type
// (the part before the dot: job, lane, question, …) beside the free-text filter of type or subject (issue #1169). A long page
// (issue #2353): 30 rows to a page, newest first, and the header with the filters stays in view; Copy takes every event
// the filters show.
import { ChevronRight, Copy, ListTree } from 'lucide-react';
import { useDeferredValue, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { detailOf, eventLineText, eventTone } from '@/components/event-line';
import { JsonBlock } from '@/components/json-block';
import { Pager, usePaged } from '@/components/pager';
import { TEXT } from '@/components/status';
import { subjectOf } from '@/model/board';
import { eventFamilies, eventFamily } from '@/model/event-families';
import { clock } from '@/model/format';
import { jobHref } from '@/model/job';
import { ROWS_PER_PAGE } from '@/model/page-prefs';
import type { DomainEvent, MachineView } from '@/model/wire';
import { Empty, Panel } from '@/components/panel';
import { useHopper } from '@/store';
import { useJobName } from '@/store/selectors';
import { cn } from '@/lib/utils';

function EventRow({ e, nameOf, machines }: { e: DomainEvent; nameOf: (jobId: string) => string; machines: readonly MachineView[] }) {
  const [open, setOpen] = useState(false);
  const subject = subjectOf(e, nameOf, machines);
  const message = detailOf(e);
  return (
    <>
      <TableRow data-event-seq={e.seq} className="text-xs">
        <TableCell className="num w-20 text-muted-foreground" title={e.at}>{clock(e.at)}</TableCell>
        <TableCell className="max-w-64 truncate" title={subject}>
          {e.jobId ? <a href={jobHref(e.jobId)} className="underline-offset-4 hover:underline">{subject}</a> : <span className="text-muted-foreground">{subject}</span>}
        </TableCell>
        <TableCell className={cn('font-medium', TEXT[eventTone(e.type)])}>{e.type}</TableCell>
        <TableCell className="max-w-96 truncate text-muted-foreground" title={message}>{message}</TableCell>
        <TableCell className="w-8 text-right">
          <Button data-slot="event-detail-toggle" size="icon-xs" variant="ghost" aria-expanded={open} aria-label={open ? 'Hide the detail' : 'Show the detail'} onClick={() => setOpen(!open)}>
            <ChevronRight className={open ? 'rotate-90 transition-transform' : 'transition-transform'} />
          </Button>
        </TableCell>
      </TableRow>
      {open && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={5} data-slot="event-detail" className="space-y-2 whitespace-normal pb-3 pl-6">
            <div className="font-mono text-[11px] text-muted-foreground">
              #{e.seq} · {e.at} · {e.id}{e.jobId && ` · job ${e.jobId}`}{e.laneId && ` · lane ${e.laneId}`}{e.machineId && ` · machine ${e.machineId}`}{e.decisionId && ` · decision ${e.decisionId}`}
            </div>
            <JsonBlock value={e.data} label={`event ${e.seq} data`} className="max-h-72" />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export function Events() {
  const events = useHopper((s) => s.events);
  const nameOf = useJobName();
  const machines = useHopper((s) => s.machines);
  const [filter, setFilter] = useState('');
  const [family, setFamily] = useState<string | undefined>(undefined);
  const f = useDeferredValue(filter.trim().toLowerCase());
  const families = useMemo(() => eventFamilies(events), [events]);
  // A chip whose last event left shows all again.
  const chip = family && families.some((x) => x.family === family) ? family : undefined;
  const shown = events.filter((e) => (!chip || eventFamily(e.type) === chip) && (!f || e.type.includes(f) || subjectOf(e, nameOf, machines).toLowerCase().includes(f)));
  const page = usePaged(shown, ROWS_PER_PAGE, `${chip ?? ''}|${f}`);
  const copy = () => { void navigator.clipboard?.writeText(shown.map((e) => eventLineText(e, nameOf, machines)).join('\n')); };
  const chipButton = (key: string, label: string, count: number, v: string | undefined) => (
    <Button key={key} data-slot="event-type-chip" data-type={key} size="xs" variant={chip === v ? 'default' : 'outline'} aria-pressed={chip === v} onClick={() => setFamily(v)}>
      {label}<span className="num ml-1 opacity-70">{count}</span>
    </Button>
  );
  return (
    <Panel title="Event stream" icon={ListTree} count={shown.length} sticky
      action={<div className="flex items-center gap-1.5">
        <Input data-slot="events-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter by type, job or lane" className="h-7 w-44 text-xs sm:w-60" />
        <Button size="xs" variant="outline" onClick={copy} disabled={!shown.length} title="Copy every event the filters show"><Copy />Copy</Button>
      </div>}>
      <div className="space-y-2">
        {families.length > 0 && (
          <div data-slot="event-type-chips" className="flex flex-wrap items-center gap-1.5" aria-label="Filter by event type">
            {chipButton('all', 'All', events.length, undefined)}
            {families.map((x) => chipButton(x.family, x.family, x.count, x.family))}
          </div>
        )}
        {shown.length ? (
          <>
            <Table data-slot="events-table">
              <TableHeader><TableRow className="text-xs"><TableHead>Time</TableHead><TableHead>Job</TableHead><TableHead>Event type</TableHead><TableHead>Message</TableHead><TableHead><span className="sr-only">Detail</span></TableHead></TableRow></TableHeader>
              <TableBody>{page.shown.map((e) => <EventRow key={e.seq} e={e} nameOf={nameOf} machines={machines} />)}</TableBody>
            </Table>
            <Pager p={page} onPage={page.setPage} />
          </>
        ) : <Empty>no events</Empty>}
      </div>
    </Panel>
  );
}
