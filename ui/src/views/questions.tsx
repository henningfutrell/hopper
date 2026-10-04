// Open questions: what the job asked, its recent output, the escalation trail, and the answer box.
import { ChevronRight, MessageCircleQuestion, Send } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Textarea } from '@/components/ui/textarea';
import { Countdown, JobTitle } from '@/components/job';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { between, clock } from '@/model/format';
import type { Question, QuestionAttempt } from '@/model/wire';
import { act, refreshQuestions, useHopper } from '@/store';
import { useJobIndex } from '@/store/selectors';

const Mark = ({ ok }: { ok: boolean }) => <span className={ok ? 'text-ok' : 'text-bad'}>{ok ? '✓' : '✗'}</span>;

function Attempt({ a }: { a: QuestionAttempt }) {
  return (
    <div className="space-y-1 border-l-2 border-border py-1 pl-3 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge status={a.tier} tone={a.tier === 'human' ? 'question' : 'muted'} />
        {a.role && <span className="text-muted-foreground">{a.role}</span>}
        {a.model && <span className="font-mono text-muted-foreground">{a.model}</span>}
        <StatusBadge status={a.outcome} />
        {a.confident != null && <span>confident <Mark ok={a.confident} /></span>}
        {a.escalate != null && <span>escalate <Mark ok={a.escalate} /></span>}
        {(a.riskRules ?? []).map((r) => <StatusBadge key={r} status={r} tone="bad" />)}
        {a.finishedAt && <span className="num text-muted-foreground">{between(a.startedAt, a.finishedAt)}</span>}
      </div>
      {a.answer && <pre className="rounded-md bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap">{a.answer}</pre>}
      {a.reason && <div className="text-muted-foreground">{a.reason}</div>}
      {a.error && <div className="text-bad">{a.error}</div>}
    </div>
  );
}

function QuestionCard({ q }: { q: Question }) {
  const job = useJobIndex().get(q.jobId);
  const authed = useHopper((s) => s.authed);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const lines = q.recentOutput.split('\n');
  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    if (await act(`/ui/api/questions/${encodeURIComponent(q.id)}/answer`, { answer: text }, 'Answer sent')) setDraft('');
    setSending(false);
    refreshQuestions().catch(() => {});
  };
  return (
    <Panel title={q.tier === 'human' ? 'For you' : `With ${q.tier}`} icon={MessageCircleQuestion} className={q.tier === 'human' ? 'border-question/40' : ''}
      action={<span className="num text-xs text-muted-foreground">asked {clock(q.createdAt)}{q.tier === 'human' && <> · notified {q.notifyCount}×</>}
        {q.tier === 'human' && q.expiresAt && <> · expires <Countdown iso={q.expiresAt} className="text-warn" /></>}</span>}
      bodyClassName="space-y-3">
      {job && <JobTitle job={job} />}
      <pre className="rounded-md border-l-2 border-question bg-question/5 p-3 font-mono text-sm whitespace-pre-wrap">{q.text}</pre>
      <Collapsible>
        <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />recent output ({Math.min(40, lines.length)} of {lines.length} lines)
        </CollapsibleTrigger>
        <CollapsibleContent><pre className="mt-2 max-h-80 overflow-auto rounded-md bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">{lines.slice(-40).join('\n')}</pre></CollapsibleContent>
      </Collapsible>
      {q.attempts.length > 0 && <div className="space-y-1.5"><div className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Escalation trail</div>{q.attempts.map((a, i) => <Attempt key={i} a={a} />)}</div>}
      {authed && (
        <div className="space-y-2">
          <Textarea rows={3} value={draft} disabled={sending} placeholder="Answer to type into the job (Ctrl/Cmd+Enter sends)"
            onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }} />
          <Button onClick={() => void send()} disabled={sending || !draft.trim()}><Send />{sending ? 'Sending…' : 'Send answer'}</Button>
        </div>
      )}
    </Panel>
  );
}

export function Questions() {
  const questions = useHopper((s) => s.questions);
  return questions.length
    ? <div className="space-y-3">{questions.map((q) => <QuestionCard key={q.id} q={q} />)}</div>
    : <Panel title="Questions" icon={MessageCircleQuestion}><Empty>no open questions</Empty></Panel>;
}
