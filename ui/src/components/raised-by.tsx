// The raising machine (issue #485): the machine a question or login prompt was raised on, by its name as it
// was then, with its id and lane on hover; "machine unknown" when none is recorded, never a blank.
import { Server } from 'lucide-react';
import { raisedName, raisedTitle } from '@/model/questions';
import type { RaisedBy } from '@/model/wire';
import { cn } from '@/lib/utils';

export function RaisedOn({ raisedBy, className }: { raisedBy: RaisedBy | undefined; className?: string }) {
  return (
    <span data-slot="raised-by" title={raisedTitle(raisedBy)} className={cn('inline-flex min-w-0 items-center gap-1', !raisedBy && 'italic', className)}>
      <Server className="size-3 shrink-0" aria-hidden />
      <span className="truncate">on {raisedName(raisedBy)}</span>
    </span>
  );
}
