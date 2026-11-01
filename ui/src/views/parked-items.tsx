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
import type { Job, ReviewItemView, ReviewKind } from '@/model/wire';
import { useHopper } from '@/store';
import { useJobIndex } from '@/store/selectors';
import { PickUpButton } from '@/views/dashboard/lanes';

type ParkedOf = Pick<NonNullable<Job['parked']>, 'by' | 'reason' | 'until' | 'untilRefused'>;

/** A park condition as a person reads it (issue #2890), after "until". */
export function untilLabel(u: NonNullable<ParkedOf['until']>): string {
  switch (u.kind) {
    case 'item': return `${u.repo}#${u.number} closes or merges`;
    case 'job': return `job ${u.jobId} ends`;
    case 'time': return new Date(u.at).toLocaleString();
  }
}

/**
 * Who parked it and why (issue #2167): `by` and `reason`, when a person parked it; auto-park and the moves say `why` instead.
 * Its park condition (issue #2890): the hopper picks it up once it holds, or it held and the pick up was refused, and why.
 */
export function ParkedBy({ parked, className }: { parked: ParkedOf | undefined; className?: string }) {
  if (!parked?.by && !parked?.reason && !parked?.until) return null;
  return (
    <div data-slot="parked-by" className={className ?? 'text-xs text-muted-foreground'}>
      {parked.by && <span>parked by {parked.by}</span>}
      {parked.by && parked.reason && <span>: </span>}
      {parked.reason && <span data-slot="parked-reason" className="italic">{parked.reason}</span>}
      {parked.until && (
        <div data-slot="parked-until">
          {parked.untilRefused
            ? <>until {untilLabel(parked.until)}: it held, but the hopper could not pick it up ({parked.untilRefused}). Pick it up yourself.</>
            : <>picked up by the hopper once {untilLabel(parked.until)}</>}
        </div>
      )}
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
