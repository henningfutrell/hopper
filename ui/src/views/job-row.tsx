// A job in the Jobs view's list (issues #434, #2353, #2372): one table row — an expand button, its stage, its issue
// (owner/repo#number), its title and task count, lane, time in stage, pull request and checks (for a partly done job also
// the pull request it waits on and what runs after its merge), its delivery step while its kept delivery track is open
// (issue #2775: a fix merged but not promoted shows where it stops, not done), and last event. A click on the row, but on
// a link, opens its run graph under it (jobs.tsx). Narrow screens drop the issue, the lane, the time, the pull request, the
// delivery step and the last event; each cell's whole text is in its title. It renders again only when what it shows changes, so the list stays
// quick with hundreds of jobs.
import { ChevronDown, ChevronRight } from 'lucide-react';
import { memo } from 'react';
import { detailOf, eventTone } from '@/components/event-line';
import { GhLink } from '@/components/job';
import { StatusBadge, TEXT } from '@/components/status';
import { cn } from '@/lib/utils';
import { clock } from '@/model/format';
import { jobHref } from '@/model/job';
import { stepLabel } from '@/model/delivery-forecast';
import { pullRequestText, pullRequestTone, stageInfo, tasksText } from '@/model/jobs-view';
import type { DomainEvent, JobGraphNode, JobStage, KeptTrack } from '@/model/wire';

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

/**
 * The table's columns, its header and each row's cells in one order. A column a narrow screen drops hides its cells and
 * keeps its `col` at no width, so the table always has every column and a run graph's row spans them all.
 */
const COLS = [
  { slot: 'row-expand', label: '', width: 'w-10', shown: '' },
  { slot: 'row-stage', label: 'Stage', width: 'w-48', shown: '' },
  { slot: 'row-issue', label: 'Issue', width: 'w-0 sm:w-56', shown: 'hidden sm:table-cell' },
  { slot: 'row-title', label: 'Title', width: '', shown: '' },
  { slot: 'row-lane', label: 'Lane', width: 'w-0 lg:w-36', shown: 'hidden lg:table-cell', title: 'its lane and machine' },
  { slot: 'row-since', label: 'In stage', width: 'w-0 md:w-16', shown: 'hidden md:table-cell', title: 'how long it is in its stage' },
  { slot: 'row-pull-request', label: 'Pull request', width: 'w-0 md:w-56', shown: 'hidden md:table-cell' },
  { slot: 'row-delivery', label: 'Delivery', width: 'w-0 xl:w-32', shown: 'hidden xl:table-cell', title: 'the delivery step its change is in, while its delivery track is open' },
  { slot: 'row-last-event', label: 'Last event', width: 'w-0 2xl:w-64', shown: 'hidden 2xl:table-cell' },
] as const;
type Col = (typeof COLS)[number]['slot'];
const COL = Object.fromEntries(COLS.map((c) => [c.slot, c.shown])) as Record<Col, string>;
export const JOB_COLUMNS = COLS.length;
const CELL = 'truncate px-2 first:pl-4';

export function JobTableHead() {
  return (
    <>
      <colgroup>{COLS.map((c) => <col key={c.slot} className={c.width} />)}</colgroup>
      <thead>
        <tr className="h-7 border-b text-left text-[11px] text-muted-foreground">
          {COLS.map((c) => <th key={c.slot} scope="col" title={'title' in c ? c.title : undefined} className={cn(CELL, 'font-medium', c.shown)}>{c.label}</th>)}
        </tr>
      </thead>
    </>
  );
}

/** Where an open kept delivery track is: its step, since when, what it waits on. */
export type DeliveryPosition = KeptTrack['current'];

interface RowProps {
  node: JobGraphNode; lane: string; last: DomainEvent | undefined; since: string | undefined; delivery: DeliveryPosition | undefined;
  expanded: boolean; onToggle: (jobId: string) => void;
}

const sameDelivery = (a: DeliveryPosition | undefined, b: DeliveryPosition | undefined): boolean =>
  a?.step === b?.step && a?.since === b?.since && a?.waitingOn === b?.waitingOn;

const same = (a: RowProps, b: RowProps): boolean =>
  a.node.id === b.node.id && a.node.stage === b.node.stage && a.node.stageText === b.node.stageText && a.node.status === b.node.status && a.node.stageSince === b.node.stageSince
  && a.node.tasks?.done === b.node.tasks?.done && a.node.tasks?.total === b.node.tasks?.total && a.lane === b.lane && a.last?.seq === b.last?.seq
  && a.since === b.since && sameDelivery(a.delivery, b.delivery) && a.expanded === b.expanded && a.onToggle === b.onToggle && JSON.stringify(a.node.pullRequest) === JSON.stringify(b.node.pullRequest);

export const JobRow = memo(function JobRow({ node, lane, last, since, delivery, expanded, onToggle }: RowProps) {
  const issue = issueOf(node);
  const detail = last ? detailOf(last) : '';
  const partly = node.partlyDone;
  const jobId = node.jobId!;
  return (
    <tr data-slot="job-row" data-job-id={jobId} data-stage={node.stage} data-status={node.status} aria-expanded={expanded}
      onClick={(e) => { if (!(e.target as Element).closest('a')) onToggle(jobId); }}
      className={cn('h-7 cursor-pointer text-xs text-muted-foreground hover:bg-muted/30', expanded && 'bg-muted/30')}>
      <td data-slot="row-expand" className={cn(CELL, COL['row-expand'])}>
        <button type="button" aria-expanded={expanded} aria-label={expanded ? 'Hide its run graph' : 'Show its run graph'} className="align-middle hover:text-foreground">
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
      </td>
      <td data-slot="row-stage" className={cn(CELL, COL['row-stage'])} title={node.stageText}><StageBadge stage={node.stage} text={node.stageText} /></td>
      <td data-slot="row-issue" className={cn(CELL, 'font-mono', COL['row-issue'])} title={issue}>{issue ? <GhLink url={node.url}>{issue}</GhLink> : 'no issue'}</td>
      <td data-slot="row-title" className={cn(CELL, COL['row-title'])} title={`${node.label}\njob ${jobId}`}>
        <span className="flex min-w-0 items-center gap-2">
          <a href={jobHref(jobId)} className="min-w-0 truncate text-sm font-medium text-foreground underline-offset-4 hover:underline">{node.label}</a>
          {node.tasks && <span data-slot="row-tasks" className="num shrink-0 font-mono" title="tasks done of its task list">{tasksText(node)}</span>}
        </span>
      </td>
      <td data-slot="row-lane" className={cn(CELL, COL['row-lane'])} title={lane}>{lane}</td>
      <td data-slot="row-since" className={cn(CELL, 'num', COL['row-since'])} title={node.stageSince ? `in this stage since ${node.stageSince}` : undefined}>{since ?? ''}</td>
      <td data-slot="row-pull-request" className={cn(CELL, COL['row-pull-request'])} title={partly ? `waits on the merge of ${prLabel(partly.pullRequest)}; then ${partly.afterMerge}` : undefined}>
        {node.pullRequest && <PullRequest pr={node.pullRequest} />}
        {partly && (
          <span data-slot="row-partly-done" className={cn('ml-2', TEXT.operator)}>
            waits on the merge of <GhLink url={partly.pullRequest}>{prLabel(partly.pullRequest)}</GhLink>; then {partly.afterMerge}
          </span>
        )}
      </td>
      <td data-slot="row-delivery" className={cn(CELL, COL['row-delivery'])}
        title={delivery ? `in ${stepLabel(delivery.step)} since ${delivery.since}; waits on ${delivery.waitingOn}` : undefined}>
        {delivery ? stepLabel(delivery.step) : ''}
      </td>
      <td data-slot="row-last-event" className={cn(CELL, COL['row-last-event'])} title={last ? `${last.at} ${last.type}${detail ? ` — ${detail}` : ''}` : undefined}>
        {last ? <>
          <span className="num font-mono text-muted-foreground/80">{clock(last.at)}</span>{' '}
          <span className={cn('font-mono font-medium', TEXT[eventTone(last.type)])}>{last.type}</span>
          {detail && <> {detail}</>}
        </> : <span className="text-muted-foreground/70">no event yet</span>}
      </td>
    </tr>
  );
}, same);
