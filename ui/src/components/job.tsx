// How a job names itself everywhere: its goal, the issue it came from, its phase when it is not doing the work
// (issue #548), after done where its pull request is — partly done, ready, merged, closed (issue #579), or waiting on a
// person's merge in a repository the hopper does not merge in (issue #2752) —, its issue's
// parts done and its lineage, parent and children (issue #729), its artifacts
// (issue #624), ticking times, and the flags a running job carries: unassigned (issue #387), its credential files not
// rewritten with its connection's new token (issue #647), held while its machine's link is down (issue #752).
import { ExternalLink, Unplug, UserX } from 'lucide-react';
import { useNow } from '@/hooks/use-now';
import { ago, clock, countdown, elapsed } from '@/model/format';
import { afterDone, goalOf, issueRef, partsOf } from '@/model/job';
import { routedByLabel } from '@/model/routing';
import type { Job } from '@/model/wire';
import { cn } from '@/lib/utils';
import { ArtifactChips } from './artifacts';
import { LineageChips } from './lineage';
import { HighTag, useIsHigh } from './priority';
import { useYoloMode } from '@/store/polled';

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

/** `wrap`: the title and its chips wrap in place of being cut off, for a narrow card that must read whole (issue #883). */
export function JobTitle({ job, className, wrap = false }: { job: Job; className?: string; wrap?: boolean }) {
  const ref = issueRef(job);
  const routed = routedByLabel(job);
  const high = useIsHigh(job);
  const after = afterDone(job, useYoloMode());
  const parts = partsOf(job);
  return (
    <div className={cn('min-w-0', className)} title={`${goalOf(job)}\njob ${job.id}`}>
      <div className={cn('text-sm font-medium text-foreground', wrap ? '[overflow-wrap:anywhere]' : 'truncate')}>{goalOf(job)}</div>
      <div className={cn('flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground', wrap && 'flex-wrap [overflow-wrap:anywhere]')}>
        {ref ? (
          <GhLink url={job.source?.url}>{ref}<ExternalLink className="size-3 opacity-60" /></GhLink>
        ) : <span>{job.id.slice(0, 8)}</span>}
        {high && <HighTag priority={job.priority} />}
        {job.phase && job.phase !== 'work' && (
          <span data-phase={job.phase} className="rounded border border-question/40 px-1 text-[10px] text-question" title={job.forkOf ? 'a fork of another job\'s question' : `in its ${job.phase} phase`}>
            {job.forkOf ? `fork: ${job.phase}` : job.phase}
          </span>
        )}
        {after && (
          <GhLink url={after.url} className={cn('rounded border px-1 text-[10px] no-underline', after.tone === 'warn' ? 'border-warn/40 text-warn' : 'border-ok/40 text-ok')}>
            <span data-after-done={after.label} title={after.title}>{after.label}</span>
          </GhLink>
        )}
        {parts && (
          <span data-parts={`${parts.done}/${parts.total}`} className={cn('rounded border px-1 text-[10px]', parts.done >= parts.total && 'border-ok/40 text-ok')}
            title={`${parts.done} of the ${parts.total} parts its issue declares are done`}>{parts.label}</span>
        )}
        <LineageChips job={job} />
        {routed && <span className="min-w-0 truncate rounded border px-1 text-[10px]" title={routed}>rule {job.spec.routedBy!.rule}</span>}
        <ArtifactChips jobId={job.id} />
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
/**
 * A running job held because its machine's link dropped (issue #752): it stays on its lane and goes on when the link is
 * back, or fails at `failsAt`.
 */
export function LinkLostFlag({ job }: { job: Job }) {
  const now = useNow();
  const l = job.linkLost;
  if (!l) return null;
  return (
    <div data-link-lost className="flex items-center gap-1.5 text-xs text-warn" title={`the link to machine ${l.machine} is down since ${l.since}`}>
      <Unplug className="size-3.5 shrink-0" />
      <span>held: link lost {ago(l.since, now)}, fails at {clock(l.failsAt)} ({countdown(l.failsAt, now)})</span>
    </div>
  );
}

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

