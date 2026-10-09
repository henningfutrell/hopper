// How a job names itself everywhere: its goal, the issue it came from, its phase when it is not doing the work
// (issue #548), and ticking times.
import { ExternalLink, UserX } from 'lucide-react';
import { useNow } from '@/hooks/use-now';
import { countdown, elapsed } from '@/model/format';
import { goalOf, issueRef } from '@/model/job';
import { routedByLabel } from '@/model/routing';
import type { Job } from '@/model/wire';
import { cn } from '@/lib/utils';
import { HighTag, useIsHigh } from './priority';

const GITHUB = 'https://github.com/';

/** Only https://github.com/ URLs become links; anything else is plain text. */
export function GhLink({ url, children, className }: { url?: string; children: React.ReactNode; className?: string }) {
  if (typeof url !== 'string' || !url.startsWith(GITHUB)) return <span className={className}>{children}</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer"
      className={cn('inline-flex items-center gap-1 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline', className)}>
      {children}
    </a>
  );
}

export function JobTitle({ job, className }: { job: Job; className?: string }) {
  const ref = issueRef(job);
  const routed = routedByLabel(job);
  const high = useIsHigh(job);
  return (
    <div className={cn('min-w-0', className)} title={`${goalOf(job)}\njob ${job.id}`}>
      <div className="truncate text-sm font-medium text-foreground">{goalOf(job)}</div>
      <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
        {ref ? (
          <GhLink url={job.source?.url}>{ref}<ExternalLink className="size-3 opacity-60" /></GhLink>
        ) : <span>{job.id.slice(0, 8)}</span>}
        {high && <HighTag priority={job.priority} />}
        {job.phase && job.phase !== 'work' && (
          <span data-phase={job.phase} className="rounded border border-question/40 px-1 text-[10px] text-question" title={job.forkOf ? 'a fork of another job\'s question' : `in its ${job.phase} phase`}>
            {job.forkOf ? `fork: ${job.phase}` : job.phase}
          </span>
        )}
        {job.source?.source === 'github-app' && <span className="rounded border px-1 text-[10px]">app</span>}
        {routed && <span className="min-w-0 truncate rounded border px-1 text-[10px]" title={routed}>rule {job.spec.routedBy!.rule}</span>}
      </div>
    </div>
  );
}

export function Since({ iso, className }: { iso: string; className?: string }) {
  const now = useNow();
  return <span className={cn('num', className)} title={iso}>{elapsed(iso, now)}</span>;
}

export function Countdown({ iso, className }: { iso: string; className?: string }) {
  const now = useNow();
  return <span className={cn('num', className)} title={iso}>{countdown(iso, now)}</span>;
}

/**
 * A started job whose issue is no longer assigned to the account it was taken for (issue #387): it runs on
 * until the user stops it (the row's cancel), or the issue is assigned to them again.
 */
export function UnassignedFlag({ job }: { job: Job }) {
  const at = job.sourceState?.sync?.unassignedAt;
  if (typeof at !== 'string') return null;
  return (
    <div data-unassigned className="flex items-center gap-1.5 text-xs text-warn" title={`unassigned since ${at}`}>
      <UserX className="size-3.5 shrink-0" />
      <span>No longer assigned to you on GitHub. Stop it, or let it finish.</span>
    </div>
  );
}
