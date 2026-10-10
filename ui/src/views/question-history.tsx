// The question history (issue #151): every handled question — answered, closed, dismissed, expired or
// cancelled — as a compact list, newest first, each row opening to its question, the answer and the
// job, each naming the machine that raised it (issue #485). In Settings, beside the question gates; the Questions view holds the open questions only.
// A level's auto-answer (issue #632) says so, and a person may correct it: the job gets the correction.
import { ChevronRight, History } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { JobTitle } from '@/components/job';
import { CardText, InlineMarkdown } from '@/components/markdown';
import { Empty, Panel } from '@/components/panel';
import { RaisedOn } from '@/components/raised-by';
import { StatusBadge, type Tone } from '@/components/status';
import { post, SessionRejected } from '@/lib/api';
import { autoAnswerOf } from '@/model/auto-answer';
import { clock } from '@/model/format';
import { firstLine } from '@/model/questions';
import type { Question, QuestionStatus } from '@/model/wire';
import { refreshQuestions, useHopper } from '@/store';
import { useCanOperate, useJobIndex } from '@/store/selectors';

const OUTCOME: Record<Exclude<QuestionStatus, 'open'>, Tone> = { answered: 'ok', closed: 'warn', dismissed: 'muted', expired: 'bad', lapsed: 'warn', cancelled: 'muted' };

/** Correct an auto-answer (issue #632): the person's answer replaces it, and the job gets it ahead of its next answer. */
function CorrectForm({ q }: { q: Question }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      await post(`/ui/api/questions/${q.id}/correct`, { answer: text });
      toast.success('Corrected: the job gets it ahead of its next answer');
      setOpen(false);
      await refreshQuestions();
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false });
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!open) return <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Correct</Button>;
  return (
    <div className="space-y-2">
      <Textarea name="correction" rows={3} className="font-mono text-xs" value={text} disabled={busy} placeholder="The right answer. The job gets it ahead of its next answer." onChange={(e) => setText(e.target.value)} />
      <div className="flex gap-2">
        <Button size="sm" disabled={busy || !text.trim()} onClick={() => void send()}>Send correction</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </div>
  );
}

/** One handled question, one line: when, outcome, the question's first line. Opens to the question, the answer and the job. */
function HandledRow({ q }: { q: Question }) {
  const job = useJobIndex().get(q.jobId);
  const status = q.status as Exclude<QuestionStatus, 'open'>;
  const auto = autoAnswerOf(q);
  const canOperate = useCanOperate();
  return (
    <Collapsible data-slot="handled-question" className="border-b last:border-b-0">
      <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted/40">
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        <span className="num shrink-0 text-xs text-muted-foreground">{clock(q.updatedAt)}</span>
        <StatusBadge status={status} tone={OUTCOME[status]} className="shrink-0" />
        {auto && <StatusBadge status={`auto · ${auto.level}`} tone="muted" className="shrink-0" />}
        {q.corrected && <StatusBadge status="corrected" tone="warn" className="shrink-0" />}
        <InlineMarkdown text={firstLine(q.text)} className="min-w-0 flex-1 truncate" />
        <RaisedOn raisedBy={q.raisedBy} className="max-w-[40%] shrink-0 text-xs text-muted-foreground" />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 px-4 pb-3 pl-9">
        {job && <JobTitle job={job} />}
        <div data-slot="question-text" className="rounded-md border-l-2 border-question bg-question/5 p-2 text-xs"><CardText text={q.text} tldr={q.tldr?.text} /></div>
        {q.answer && <div className="space-y-1">
          <div className="text-[11px] text-muted-foreground">{q.status === 'closed' ? 'closed without answering' : 'answer'} · by {q.answeredBy ?? 'unknown'}</div>
          <div className="rounded-md bg-muted/50 p-2 text-xs"><CardText text={q.answer} /></div>
        </div>}
        {auto && <div className="space-y-2">
          <div className="text-xs text-muted-foreground">answered by {auto.level}{auto.confidence ? ` at ${auto.confidence} confidence` : ''}, with no person</div>
          {canOperate && <CorrectForm q={q} />}
        </div>}
        {q.corrected && <div className="space-y-1">
          <div className="text-[11px] text-muted-foreground">corrected {clock(q.corrected.at)} by {q.corrected.by}; {q.corrected.level} had answered</div>
          <pre className="rounded-md bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap line-through decoration-muted-foreground/60">{q.corrected.was}</pre>
        </div>}
        {q.status === 'dismissed' && <div className="text-xs text-muted-foreground">dismissed: nothing was typed into the job</div>}
        {q.status === 'expired' && <div className="text-xs text-bad">expired unanswered: the job failed</div>}
        {q.status === 'lapsed' && <div className="text-xs text-warn">lapsed: nobody answered in time, so Claude Code denied it by itself and the job went on</div>}
        {q.status === 'cancelled' && <div className="text-xs text-muted-foreground">cancelled with its job</div>}
        <div className="num text-[11px] text-muted-foreground">asked {clock(q.createdAt)} <RaisedOn raisedBy={q.raisedBy} className="align-bottom" /> · {q.attempts.length} attempt{q.attempts.length === 1 ? '' : 's'}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function QuestionHistory() {
  const handled = useHopper((s) => s.handled);
  return (
    <Panel title="Question history" icon={History} count={handled.length} bodyClassName="p-0">
      {handled.length
        ? <div data-slot="handled-questions">{handled.map((q) => <HandledRow key={q.id} q={q} />)}</div>
        : <Empty>no handled questions yet</Empty>}
    </Panel>
  );
}
