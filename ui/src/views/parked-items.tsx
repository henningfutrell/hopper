// Parked proposals and research reports (issue #2167): the open items whose job a person parked, out of their section's
// list (GET /api/<section>?status=parked). One compact row each — its job, its first part (a proposal's TL;DR, a report's
// question), how long it has been parked, by whom and why — and Pick up, which puts it back where it was. Folded until
// opened: they wait on nobody.
import { ChevronRight, CirclePause } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { JobTitle, Since } from '@/components/job';
import { InlineMarkdown } from '@/components/markdown';
import { firstLine } from '@/model/questions';
import { REVIEW_UI } from '@/model/reviews';
import type { ReviewItemView, ReviewKind } from '@/model/wire';
import { useHopper } from '@/store';
import { useJobIndex } from '@/store/selectors';
import { PickUpButton } from '@/views/dashboard/lanes';

/** Who parked it and why (issue #2167): `by` and `reason`, when a person parked it; auto-park and the moves say `why` instead. */
export function ParkedBy({ parked, className }: { parked: { by?: string; reason?: string } | undefined; className?: string }) {
  if (!parked?.by && !parked?.reason) return null;
  return (
    <div data-slot="parked-by" className={className ?? 'text-xs text-muted-foreground'}>
      {parked.by && <span>parked by {parked.by}</span>}
      {parked.by && parked.reason && <span>: </span>}
      {parked.reason && <span data-slot="parked-reason" className="italic">{parked.reason}</span>}
    </div>
  );
}

function ParkedItemRow({ kind, p }: { kind: ReviewKind; p: ReviewItemView }) {
  const job = useJobIndex().get(p.jobId);
  const type = useHopper((s) => s.reviews[kind].type);
  const latest = p.versions.at(-1)!;
  const first = type?.parts[0]?.[0];
  const headline = (first && latest.sections[first]) || latest.text;
  return (
    <div data-parked-item={p.id} className="space-y-1 px-4 py-2.5">
      <div className="flex items-start gap-2">
        {job ? <JobTitle job={job} className="flex-1" /> : <div className="flex-1 text-sm font-medium">{p.source?.title ?? p.jobId}</div>}
        {job && <PickUpButton job={job} />}
      </div>
      <div data-slot="item-line" className="truncate text-xs" title={headline}><InlineMarkdown text={firstLine(headline)} /></div>
      <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        <span data-slot="parked-since">{REVIEW_UI[kind].noun}, version {latest.number} · parked <Since iso={p.parked?.at ?? p.updatedAt} /> ago</span>
        <ParkedBy parked={p.parked} className="" />
      </div>
    </div>
  );
}

export function ParkedItems({ kind }: { kind: ReviewKind }) {
  const parked = useHopper((s) => s.reviews[kind].parked);
  if (parked.length === 0) return null;
  return (
    <Collapsible data-slot="parked-items" className="rounded-md border">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-4 py-2 text-sm text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
        <CirclePause className="size-4" />Parked ({parked.length})
      </CollapsibleTrigger>
      <CollapsibleContent className="divide-y border-t">
        {parked.map((p) => <ParkedItemRow key={p.id} kind={kind} p={p} />)}
      </CollapsibleContent>
    </Collapsible>
  );
}
