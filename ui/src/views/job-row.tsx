// A job in the Jobs view's list mode (issues #434, #2353): one line — its title, task count and stage, then its issue
// (owner/repo#number), lane, time in stage, pull request and checks, and last event; a partly done job names the pull
// request it waits on and what runs after its merge. Narrow screens drop the lane and the last event; each part's whole
// text is in its title. It renders again only when what it shows changes, so the list stays quick with hundreds of jobs.
import { memo } from 'react';
import { detailOf, eventTone } from '@/components/event-line';
import { GhLink } from '@/components/job';
import { StatusBadge, TEXT } from '@/components/status';
import { cn } from '@/lib/utils';
import { clock } from '@/model/format';
import { jobHref } from '@/model/job';
import { pullRequestText, pullRequestTone, stageInfo, tasksText } from '@/model/jobs-view';
import type { DomainEvent, JobGraphNode, JobStage } from '@/model/wire';

export function StageBadge({ stage, text }: { stage: JobStage; text?: string }) {
  const s = stageInfo(stage);
  return <StatusBadge status={stage} label={text || s.label} tone={s.tone} title={s.title} />;
}

export const prLabel = (url: string): string => { const n = /\/pull\/(\d+)/.exec(url)?.[1]; return n ? `PR #${n}` : 'its pull request'; };

export function PullRequest({ pr }: { pr: NonNullable<JobGraphNode['pullRequest']> }) {
  return (
    <span data-slot="row-pr" className="inline-flex min-w-0 items-center gap-1.5">
      <GhLink url={pr.url}>{prLabel(pr.url)}</GhLink>
      <span className={cn('truncate', TEXT[pullRequestTone(pr)])}>{pullRequestText(pr)}</span>
    </span>
  );
}

export const issueOf = (n: JobGraphNode): string | undefined => (n.repo && n.number !== undefined ? `${n.repo}#${n.number}` : undefined);

interface RowProps { node: JobGraphNode; lane: string; last: DomainEvent | undefined; since: string | undefined }

const same = (a: RowProps, b: RowProps): boolean =>
  a.node.id === b.node.id && a.node.stage === b.node.stage && a.node.stageText === b.node.stageText && a.node.status === b.node.status && a.node.stageSince === b.node.stageSince
  && a.node.tasks?.done === b.node.tasks?.done && a.node.tasks?.total === b.node.tasks?.total && a.lane === b.lane && a.last?.seq === b.last?.seq
  && a.since === b.since && JSON.stringify(a.node.pullRequest) === JSON.stringify(b.node.pullRequest);

export const JobRow = memo(function JobRow({ node, lane, last, since }: RowProps) {
  const issue = issueOf(node);
  const detail = last ? detailOf(last) : '';
  const partly = node.partlyDone;
  return (
    <li data-slot="job-row" data-job-id={node.jobId} data-stage={node.stage} data-status={node.status}
      className="flex h-9 min-w-0 items-center gap-3 px-4 text-xs text-muted-foreground hover:bg-muted/30">
      <a href={jobHref(node.jobId!)} className="min-w-0 flex-1 truncate text-sm font-medium text-foreground underline-offset-4 hover:underline" title={`${node.label}\njob ${node.jobId}`}>{node.label}</a>
      {node.tasks && <span data-slot="row-tasks" className="num shrink-0 font-mono" title="tasks done of its task list">{tasksText(node)}</span>}
      <span data-slot="row-stage" className="shrink-0"><StageBadge stage={node.stage} text={node.stageText} /></span>
      <span data-slot="row-issue" className="hidden w-36 shrink-0 truncate font-mono sm:inline">{issue ? <GhLink url={node.url}>{issue}</GhLink> : 'no issue'}</span>
      <span data-slot="row-lane" title="its lane" className="hidden w-32 shrink-0 truncate lg:inline">{lane}</span>
      <span data-slot="row-since" title={node.stageSince ? `in this stage since ${node.stageSince}` : undefined} className="num hidden w-16 shrink-0 truncate md:inline">{since ?? ''}</span>
      <span className="hidden w-48 shrink-0 truncate md:inline">{node.pullRequest && <PullRequest pr={node.pullRequest} />}</span>
      {partly && (
        <span data-slot="row-partly-done" className={cn('hidden max-w-64 shrink-0 truncate md:inline', TEXT.operator)} title={`waits on the merge of ${prLabel(partly.pullRequest)}; then ${partly.afterMerge}`}>
          waits on the merge of <GhLink url={partly.pullRequest}>{prLabel(partly.pullRequest)}</GhLink>; then {partly.afterMerge}
        </span>
      )}
      <span data-slot="row-last-event" className="hidden w-64 shrink-0 truncate xl:inline" title={last ? `${last.at} ${last.type}${detail ? ` — ${detail}` : ''}` : undefined}>
        {last ? <>
          <span className="num font-mono text-muted-foreground/80">{clock(last.at)}</span>{' '}
          <span className={cn('font-mono font-medium', TEXT[eventTone(last.type)])}>{last.type}</span>
          {detail && <> {detail}</>}
        </> : <span className="text-muted-foreground/70">no event yet</span>}
      </span>
    </li>
  );
}, same);
