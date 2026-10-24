import type { Job } from '@/model/wire';
import { jobHref } from '@/model/job';

/**
 * Issue #2722 part 7: the job ended well, but its reap read a process of it that failed (its check may have aborted and
 * looked green) or a scope it could not stop. Its parts list says each.
 */
export function FailedProcessesLine({ job }: { job: Job }) {
  const f = job.status === 'finished' ? job.failedProcesses : undefined;
  if (!f) return null;
  return (
    <a data-failed-processes href={jobHref(job.id)} className="block text-xs text-warn hover:underline">
      {`Done, but ${f.said}.${f.processes ? ' Make sure that its checks ran and passed.' : ''}`}
    </a>
  );
}
