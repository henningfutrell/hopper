// The job's timeline on its job view, as a Trace (issue #1169): one step line per event, newest first. A step that failed
// is an error, the newest step of a job at work runs, and a job that waits for a lane shows that wait as a pending line
// on top. Each step opens to its data in a small code block.
import { Circle, CircleCheck, CircleDot, CircleX, MessageCircleQuestion, TriangleAlert, UserRound, type LucideIcon } from 'lucide-react';
import { Empty } from '@/components/panel';
import { TEXT, type Tone } from '@/components/status';
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton, CodeBlockLine } from '@/components/ui/code-block';
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle } from '@/components/ui/trace';
import { useHighlightedCode } from '@/hooks/use-highlighted-code';
import { subjectOf } from '@/model/board';
import { clock } from '@/model/format';
import type { DomainEvent, Job, MachineView } from '@/model/wire';
import { detailOf, eventTone } from './event-line';

type StepStatus = 'running' | 'error' | 'pending';

const ICON: Record<Tone, LucideIcon> = {
  busy: CircleDot, ok: CircleCheck, bad: CircleX, warn: TriangleAlert, question: MessageCircleQuestion, operator: UserRound, muted: Circle,
};
const SAID: Record<StepStatus, string> = { running: 'in progress', error: 'failed', pending: 'pending' };

/** A job with a lane: its newest step is the one it works on now. */
const AT_WORK: ReadonlySet<string> = new Set(['claimed', 'running']);

/** The step's status: an event that tells of a failure is an error; the newest step of a job at work runs. */
function stepStatus(e: DomainEvent, job: Job | undefined, newest: boolean): StepStatus | undefined {
  if (eventTone(e.type) === 'bad') return 'error';
  if (newest && job && AT_WORK.has(job.status)) return 'running';
  return undefined;
}

/** What a job not yet at work waits for, or nothing. */
function waitOf(job: Job | undefined): string | undefined {
  if (job?.status === 'queued') return 'waits for a lane';
  if (job?.status === 'held') return `held${job.holdReason ? `: ${job.holdReason}` : ''}`;
  return undefined;
}

function StepData({ e }: { e: DomainEvent }) {
  const json = JSON.stringify(e.data, null, 2);
  const lines = useHighlightedCode(json, 'json');
  return (
    <CodeBlock size="sm">
      <CodeBlockActions><CodeBlockCopyButton value={json} /></CodeBlockActions>
      <CodeBlockContent aria-label={`data of ${e.type}`} className="max-h-72">
        {lines.map((line, i) => <CodeBlockLine key={i}>{line}</CodeBlockLine>)}
      </CodeBlockContent>
    </CodeBlock>
  );
}

export function JobTimeline({ job, events, nameOf, machines }: {
  job?: Job; events: readonly DomainEvent[]; nameOf: (jobId: string) => string; machines: readonly Pick<MachineView, 'id' | 'label'>[];
}) {
  const wait = waitOf(job);
  return (
    <div data-slot="job-timeline">
      <Trace role="list" aria-label="Job timeline">
        {wait && (
          <div role="listitem">
            <TraceLine status="pending">
              <TraceIcon><Circle /></TraceIcon>
              <TraceTitle>{wait}</TraceTitle>
              <span className="sr-only">, {SAID.pending}</span>
            </TraceLine>
          </div>
        )}
        {events.map((e, i) => {
          const status = stepStatus(e, job, i === 0);
          const tone = eventTone(e.type);
          const Icon = ICON[tone];
          const detail = detailOf(e);
          const subject = subjectOf(e, nameOf, machines);
          return (
            <TraceCollapsible key={e.seq} role="listitem" data-event-seq={e.seq}>
              <TraceCollapsibleTrigger>
                <TraceLine status={status}>
                  <TraceIcon className={TEXT[tone]}><Icon /></TraceIcon>
                  <TraceTitle title={detail ? `${subject} — ${detail}` : subject}>
                    <span className="font-mono text-xs">{e.type}</span>
                    {detail && <span> — {detail}</span>}
                  </TraceTitle>
                  <TraceDescription className="font-mono text-xs" title={e.at}>{clock(e.at)}</TraceDescription>
                  {status && <span className="sr-only">, {SAID[status]}</span>}
                </TraceLine>
              </TraceCollapsibleTrigger>
              <TraceCollapsibleContent><StepData e={e} /></TraceCollapsibleContent>
            </TraceCollapsible>
          );
        })}
      </Trace>
      {events.length === 0 && <Empty>no events of this job yet</Empty>}
    </div>
  );
}
