// The question history (issue #151): every handled question — answered, closed, dismissed, expired or
// cancelled — as a compact list, newest first, each row opening to its question, the answer and the
// job. In Settings, beside the question gates; the Questions view holds the open questions only.
import { ChevronRight, History } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { JobTitle } from '@/components/job';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge, type Tone } from '@/components/status';
import { clock } from '@/model/format';
import type { Question, QuestionStatus } from '@/model/wire';
import { useHopper } from '@/store';
import { useJobIndex } from '@/store/selectors';

const OUTCOME: Record<Exclude<QuestionStatus, 'open'>, Tone> = { answered: 'ok', closed: 'warn', dismissed: 'muted', expired: 'bad', lapsed: 'warn', cancelled: 'muted' };
const firstLine = (s: string) => s.split('\n').find((l) => l.trim())?.trim() ?? '';

/** One handled question, one line: when, outcome, the question's first line. Opens to the question, the answer and the job. */
function HandledRow({ q }: { q: Question }) {
  const job = useJobIndex().get(q.jobId);
  const status = q.status as Exclude<QuestionStatus, 'open'>;
  return (
    <Collapsible data-slot="handled-question" className="border-b last:border-b-0">
      <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted/40">
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        <span className="num shrink-0 text-xs text-muted-foreground">{clock(q.updatedAt)}</span>
        <StatusBadge status={status} tone={OUTCOME[status]} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{firstLine(q.text)}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 px-4 pb-3 pl-9">
        {job && <JobTitle job={job} />}
        <pre className="rounded-md border-l-2 border-question bg-question/5 p-2 font-mono text-xs whitespace-pre-wrap">{q.text}</pre>
        {q.answer && <div className="space-y-1">
          <div className="text-[11px] text-muted-foreground">{q.status === 'closed' ? 'closed without answering' : 'answer'} · by {q.answeredBy ?? 'unknown'}</div>
          <pre className="rounded-md bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap">{q.answer}</pre>
        </div>}
        {q.status === 'dismissed' && <div className="text-xs text-muted-foreground">dismissed: nothing was typed into the job</div>}
        {q.status === 'expired' && <div className="text-xs text-bad">expired unanswered: the job failed</div>}
        {q.status === 'lapsed' && <div className="text-xs text-warn">lapsed: nobody answered in time, so Claude Code denied it by itself and the job went on</div>}
        {q.status === 'cancelled' && <div className="text-xs text-muted-foreground">cancelled with its job</div>}
        <div className="num text-[11px] text-muted-foreground">asked {clock(q.createdAt)} · {q.attempts.length} attempt{q.attempts.length === 1 ? '' : 's'}</div>
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
