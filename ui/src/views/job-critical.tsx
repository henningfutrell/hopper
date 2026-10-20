// The critical flag on a job's view (issue #2203, part 2): whether the job is a critical job, and why — the critical flag a
// person set, or its priority at or above the critical priority —, and for an operator, Mark critical, which sets the flag
// on any job that has not ended, whatever its priority, or Clear critical flag (POST /ui/api/jobs/:id/critical). The
// critical job tracker then shows the job on every page, or no longer when only the flag made it critical.
import { Siren } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { criticalText, hasEnded, isCriticalJob } from '@/model/critical-jobs';
import type { Job } from '@/model/wire';
import { act, useHopper } from '@/store';
import { useCanOperate } from '@/store/selectors';

export function JobCritical({ job }: { job: Job }) {
  const operate = useCanOperate();
  const critical = useHopper((s) => s.criticalPriority);
  const at = `/ui/api/jobs/${encodeURIComponent(job.id)}/critical`;
  const yes = isCriticalJob(job, critical);
  return (
    <div className="flex flex-wrap gap-2 text-xs">
      <span className="w-20 shrink-0 text-muted-foreground">critical</span>
      <span data-slot="job-critical" data-critical={yes} className={yes ? 'min-w-0 break-words text-bad' : 'min-w-0 break-words'}>{criticalText(job, critical)}</span>
      {operate && (job.critical
        ? <Button size="xs" variant="outline" onClick={() => act(at, { critical: false }, 'Critical flag cleared')}>Clear critical flag</Button>
        : !hasEnded(job) && <Button size="xs" variant="outline" onClick={() => act(at, { critical: true }, 'Job marked critical')}><Siren />Mark critical</Button>)}
    </div>
  );
}
