// Needs you (issue #897): the first nav entry, the one inbox of every decision that waits on a person. A row per kind —
// Intake, Access requests, Questions, Proposals, Research, Logins, Failures, the pre-sort — with its count, a high-priority
// mark (#535), and a link to the page that is its one home; nothing is acted on here. Always rendered: every row shows,
// with what it counts, also when nothing waits.
import { ArrowRight, BellRing, ChevronsUp } from 'lucide-react';
import { Empty, Panel } from '@/components/panel';
import { cn } from '@/lib/utils';
import { needsYouTotal } from '@/model/needs-you';
import { useNeedsYou } from '@/store/needs-you';

export function NeedsYou() {
  const rows = useNeedsYou();
  const total = needsYouTotal(rows);
  return (
    <div className="max-w-2xl space-y-3">
      <Panel title="Needs you" icon={BellRing} count={total.n || ''} bodyClassName="space-y-3">
        <p className="text-sm text-muted-foreground">Every decision that waits on you, by kind. Each row opens the one page where you act on it. <a href="/help/needs-you" className="underline">Help</a></p>
        {total.n === 0 && <Empty>Nothing waits on you.</Empty>}
        <ul className="divide-y rounded-md border">
          {rows.map((r) => (
            <li key={r.kind} data-needs-you={r.kind}>
              <a href={r.href} className={cn('flex items-center gap-3 px-3 py-2 text-sm hover:bg-muted/60', r.n === 0 && 'text-muted-foreground')}>
                <span data-needs-you-count className={cn('num flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 text-xs font-semibold', r.n > 0 ? 'bg-warn text-background' : 'bg-muted')}>{r.n}</span>
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{r.label}</span>
                  {r.high > 0 && <span className="ml-2 inline-flex items-center gap-0.5 text-xs text-warn"><ChevronsUp className="size-3" aria-hidden />{r.high} high priority</span>}
                  <span className="block text-xs text-muted-foreground">{r.what}</span>
                </span>
                <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              </a>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
