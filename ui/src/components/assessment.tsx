// A failed job's assessment (issue #509), where its error shows: the assessor's summary, its reasons on hover,
// and a link to the Failures view.
import { Stethoscope } from 'lucide-react';
import type { Job } from '@/model/wire';
import { cn } from '@/lib/utils';

export function AssessmentLine({ job, className }: { job: Job; className?: string }) {
  const a = job.assessment;
  if (!a) return null;
  return (
    <a href="#failures" data-assessment={a.decision} title={a.reasons.join('\n')}
      className={cn('flex items-start gap-1.5 text-xs text-muted-foreground hover:text-foreground', className)}>
      <Stethoscope className="mt-0.5 size-3 shrink-0" />
      <span className="line-clamp-2">{a.summary}</span>
    </a>
  );
}
