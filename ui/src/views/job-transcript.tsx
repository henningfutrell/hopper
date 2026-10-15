// The job's transcript on its job view (issue #1169 part 4): an operator opens the agent session the job's latest
// checkpoint keeps (POST /ui/api/jobs/:id/transcript), a page of turns at a time. Each turn is a prompt and the agent's
// reply as Messages in a Message Scroller, which starts at the newest turn and keeps its place when earlier turns load in
// front. The reply's text is Markdown; its steps — reasoning, tool calls, the plan, subagents — are a Trace, and each
// step opens to its input and result in a small code block. A new checkpoint reads the newest turns again. While the job
// is at work the transcript follows it (part 7): each read asks for it fresh, so the daemon takes a checkpoint first, at
// most once a minute, and the view reads again each minute. A newer read keeps the earlier turns already loaded in front.
import { Bot, Brain, Circle, CircleCheck, CircleDot, ListTodo, MessagesSquare, Wrench, X, type LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Markdown } from '@/components/markdown';
import { Empty, Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton, CodeBlockHeader, CodeBlockTitle } from '@/components/ui/code-block';
import { Message, MessageContent, MessageHeader } from '@/components/ui/message';
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from '@/components/ui/message-scroller';
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle } from '@/components/ui/trace';
import { post } from '@/lib/api';
import { clock } from '@/model/format';
import { AT_WORK } from '@/model/timeline-steps';
import type { Job, JobTranscript as Transcript, TranscriptPart, TranscriptTurn } from '@/model/wire';
import { useCanOperate } from '@/store/selectors';

/** How many turns a read asks for. */
const PAGE = 20;
/** How often an open transcript of a job at work reads again: the daemon takes a fresh checkpoint at most once a minute. */
export const FOLLOW_MS = 60000;
const CUT = ' (cut: the rest is not kept here)';

/** A tool call's input or result, or a subagent's prompt, in a small code block with copy. */
function StepText({ title, text, truncated }: { title: string; text: string; truncated?: boolean }) {
  return (
    <CodeBlock size="sm">
      <CodeBlockHeader>
        <CodeBlockTitle>{title}{truncated ? CUT : ''}</CodeBlockTitle>
        <CodeBlockActions><CodeBlockCopyButton value={text} /></CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent wrap aria-label={title} className="max-h-72">{text || '(empty)'}</CodeBlockContent>
    </CodeBlock>
  );
}

const PLAN_ICON: Record<'pending' | 'in_progress' | 'completed', LucideIcon> = { pending: Circle, in_progress: CircleDot, completed: CircleCheck };
const PLAN_SAID = { pending: 'to do', in_progress: 'in progress', completed: 'done' } as const;

/** One step of a reply: a line that opens to what it holds. `running`: a tool call with no result while the job works. */
function Step({ part, running }: { part: Exclude<TranscriptPart, { kind: 'text' }>; running: boolean }) {
  const line = (icon: LucideIcon, title: string, label: string, status?: 'running' | 'error', description?: string) => {
    const Icon = icon;
    return (
      <TraceCollapsibleTrigger aria-label={label}>
        <TraceLine status={status}>
          <TraceIcon><Icon /></TraceIcon>
          <TraceTitle title={title}>{title}</TraceTitle>
          {description && <TraceDescription className="text-xs">{description}</TraceDescription>}
        </TraceLine>
      </TraceCollapsibleTrigger>
    );
  };
  if (part.kind === 'reasoning') {
    return (
      <TraceCollapsible role="listitem">
        {line(Brain, 'Thinking', 'Thinking')}
        <TraceCollapsibleContent><p className="text-xs whitespace-pre-wrap">{part.text}{part.truncated ? CUT : ''}</p></TraceCollapsibleContent>
      </TraceCollapsible>
    );
  }
  if (part.kind === 'plan') {
    const done = part.items.filter((i) => i.status === 'completed').length;
    return (
      <TraceCollapsible role="listitem">
        {line(ListTodo, 'Plan', `Plan, ${done} of ${part.items.length} done`, undefined, `${done}/${part.items.length}`)}
        <TraceCollapsibleContent>
          <ul className="space-y-1 text-xs">
            {part.items.map((item, i) => {
              const Icon = PLAN_ICON[item.status];
              return (
                <li key={i} className="flex items-start gap-2">
                  <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  <span className={item.status === 'completed' ? 'line-through' : undefined}>{item.text}</span>
                  <span className="sr-only">, {PLAN_SAID[item.status]}</span>
                </li>
              );
            })}
          </ul>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    );
  }
  const status = part.error ? 'error' : part.result === undefined && running ? 'running' : undefined;
  const said = status === 'error' ? ', failed' : status === 'running' ? ', in progress' : '';
  if (part.kind === 'subagent') {
    return (
      <TraceCollapsible role="listitem">
        {line(Bot, part.title, `Subagent${part.agent ? ` ${part.agent}` : ''}: ${part.title}${said}`, status, part.agent)}
        <TraceCollapsibleContent className="space-y-2">
          <StepText title="Prompt" text={part.prompt} truncated={part.truncated} />
          {part.result !== undefined && <StepText title="Result" text={part.result} truncated={part.truncated} />}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    );
  }
  return (
    <TraceCollapsible role="listitem">
      {line(Wrench, part.title, `${part.name}: ${part.title}${said}`, status, part.name)}
      <TraceCollapsibleContent className="space-y-2">
        <StepText title="Input" text={part.input} truncated={part.truncated} />
        {part.result !== undefined && <StepText title={part.error ? 'Error' : 'Result'} text={part.result} truncated={part.truncated} />}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/** A reply's parts: each text as Markdown, each run of steps between texts as one Trace. */
function Reply({ parts, running }: { parts: TranscriptPart[]; running: boolean }) {
  const runs: (TranscriptPart & { kind: 'text' } | Exclude<TranscriptPart, { kind: 'text' }>[])[] = [];
  for (const p of parts) {
    const last = runs.at(-1);
    if (p.kind === 'text') runs.push(p);
    else if (Array.isArray(last)) last.push(p);
    else runs.push([p]);
  }
  return (
    <>
      {runs.map((r, i) => (Array.isArray(r)
        ? <Trace key={i} role="list" aria-label="Steps">{r.map((p, j) => <Step key={j} part={p} running={running && i === runs.length - 1 && j === r.length - 1} />)}</Trace>
        : <Markdown key={i} text={r.truncated ? `${r.text}\n\n*${CUT.trim()}*` : r.text} className="text-sm" />))}
    </>
  );
}

function Turn({ turn, running }: { turn: TranscriptTurn; running: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      {turn.prompt !== undefined && (
        <Message align="end">
          <MessageContent>
            <MessageHeader>Prompt{turn.at ? ` · ${clock(turn.at)}` : ''}</MessageHeader>
            <div className="max-h-48 max-w-[85%] overflow-y-auto rounded-lg bg-muted px-3 py-2 text-sm whitespace-pre-wrap">
              {turn.prompt}{turn.truncated ? CUT : ''}
            </div>
          </MessageContent>
        </Message>
      )}
      {turn.parts.length > 0 && (
        <Message align="start">
          <MessageContent>
            <MessageHeader>Agent</MessageHeader>
            <Reply parts={turn.parts} running={running} />
          </MessageContent>
        </Message>
      )}
    </div>
  );
}

type Read = { at: string; start: number; total: number; turns: TranscriptTurn[]; stale?: string };

/**
 * A read of the newest turns over the one shown. The session only grows, so a turn keeps its index: the earlier turns
 * already loaded stay in front of the newer read's, and the scroller does not jump.
 */
export function newer(shown: Read | undefined, t: Transcript): Read {
  const next: Read = { at: t.checkpointAt, start: t.start, total: t.total, turns: t.turns, ...(t.stale ? { stale: t.stale } : {}) };
  if (!shown || shown.start >= t.start || t.total < shown.total) return next;
  return { ...next, start: shown.start, turns: [...shown.turns.filter((x) => x.index < t.start), ...t.turns] };
}

function TranscriptBody({ job }: { job: Job }) {
  const [read, setRead] = useState<Read | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const path = `/ui/api/jobs/${encodeURIComponent(job.id)}/transcript`;
  const checkpointAt = job.checkpoint?.at;
  const atWork = AT_WORK.has(job.status);
  // A job at work is followed each minute: the checkpoint its fresh read took is no reason to read again at once.
  const again = atWork ? 'follow' : checkpointAt;

  useEffect(() => {
    let gone = false;
    const once = () => post<Transcript>(path, atWork ? { limit: PAGE, fresh: true } : { limit: PAGE }).then(
      (t) => { if (!gone) { setRead((shown) => newer(shown, t)); setError(undefined); } },
      (e: unknown) => { if (!gone) setError((e as Error).message); },
    );
    void once();
    const follow = atWork ? setInterval(() => void once(), FOLLOW_MS) : undefined;
    return () => { gone = true; if (follow) clearInterval(follow); };
  }, [path, again, atWork]);

  const earlier = async () => {
    if (!read) return;
    setBusy(true);
    try {
      const t = await post<Transcript>(path, { before: read.start, limit: PAGE });
      // Another checkpoint since: its turns are another reading, so start again from its newest.
      if (t.checkpointAt !== read.at) setRead(newer(undefined, t));
      else setRead({ ...read, start: t.start, turns: [...t.turns, ...read.turns] });
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  if (error && !read) return <div data-slot="job-transcript-error" className="text-xs text-bad">{error}</div>;
  if (!read) return <Empty>reading the transcript…</Empty>;
  return (
    <>
      <div data-slot="job-transcript-status" className="text-xs text-muted-foreground">
        {read.total} turns, as the checkpoint of {read.at} kept them{read.start > 0 ? `; the newest ${read.total - read.start} shown` : ''}
        {atWork && !read.stale ? '. It follows the job: read again each minute.' : ''}
      </div>
      {read.stale && <div data-slot="job-transcript-stale" className="text-xs text-warn">No new checkpoint now: {read.stale}. This is the last one kept.</div>}
      {error && <div data-slot="job-transcript-error" className="text-xs text-bad">{error}</div>}
      <div className="h-[32rem] rounded-md border">
        <MessageScrollerProvider defaultScrollPosition="end">
          <MessageScroller>
            <MessageScrollerViewport preserveScrollOnPrepend aria-label="Transcript" className="px-3">
              <MessageScrollerContent className="py-3">
                {read.start > 0 && (
                  <Button size="sm" variant="outline" className="self-center" disabled={busy} onClick={() => void earlier()}>Load earlier turns</Button>
                )}
                {read.turns.map((t) => (
                  <MessageScrollerItem key={t.index} messageId={`turn-${t.index}`} scrollAnchor={t.prompt !== undefined}>
                    <Turn turn={t} running={atWork && t.index === read.total - 1} />
                  </MessageScrollerItem>
                ))}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
      </div>
    </>
  );
}

export function JobTranscript({ job }: { job: Job }) {
  const operate = useCanOperate();
  const [open, setOpen] = useState(false);
  if (!operate || !job.checkpoint?.session) return null;
  return (
    <Panel title="Transcript" icon={MessagesSquare} bodyClassName="space-y-2"
      action={open ? <Button size="sm" variant="ghost" onClick={() => setOpen(false)}><X />Close</Button> : undefined}>
      <div data-slot="job-transcript" className="space-y-2">
        {!open && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Button size="sm" variant="outline" onClick={() => setOpen(true)}><MessagesSquare />Open transcript</Button>
            <span>Read the agent&apos;s session as its last checkpoint kept it: its prompts, replies and steps.</span>
          </div>
        )}
        {open && <TranscriptBody job={job} />}
      </div>
    </Panel>
  );
}
