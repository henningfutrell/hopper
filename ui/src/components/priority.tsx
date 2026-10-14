// High priority as the UI shows it (issue #535): one tag on every job, question, login and hand-off at or above the
// threshold, and the mark of a priority lane.
import { ChevronsUp, Star } from 'lucide-react';
import { cn } from '@/lib/utils';
import { isHighJob } from '@/model/priority';
import type { Job } from '@/model/wire';
import { useHopper } from '@/store';

/** Whether the job is high priority by the threshold the queue answered. */
export const useIsHigh = (job: Pick<Job, 'priority'> | undefined): boolean => isHighJob(job, useHopper((s) => s.highPriority));

export function HighTag({ priority, className }: { priority: number; className?: string }) {
  return (
    <span data-slot="high-priority" title={`High priority (${priority}): listed first everywhere, and first on a priority lane`}
      className={cn('inline-flex shrink-0 items-center gap-0.5 rounded border border-warn/50 bg-warn/10 px-1 text-[10px] font-semibold text-warn', className)}>
      <ChevronsUp className="size-3" />high
    </span>
  );
}

export function PriorityLaneMark({ className }: { className?: string }) {
  return (
    <span data-slot="priority-lane" title="A priority lane: one of the most reliable lanes, which high-priority jobs get first (Machines says why)"
      className={cn('inline-flex shrink-0 items-center gap-0.5 rounded border px-1 text-[10px] text-muted-foreground', className)}>
      <Star className="size-3" />priority
    </span>
  );
}
