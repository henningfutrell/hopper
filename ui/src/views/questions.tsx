// Open questions: what the job asked, its recent output, the escalation trail, and the answer box
// with Send answer, Close and Dismiss, and Park for the job waiting on it (issue #530: where a person decides the job
// must wait; or why it cannot be parked). A level's recommendation on the trail is sent in one click, Use answer, by
// the same route as Send answer; the card says in place whether it was sent, or why not with Retry (issue #459). A 403 on a mutation drops the UI to logged out: the landing
// page (issue #213). Shown, the owner's
// questions are marked seen (the nav badge clears). The header names the machine that raised the question (issue #485). Only the open questions: the question history and
// the question gates are in Settings (issue #151). A session whose UI role cannot act (viewer) sees a
// notice instead of the box. One order, the API's: high-priority jobs' questions first (issue #535), tagged, then oldest
// first, the longest waiting on top (issue #450).
// Research this and Propose this (issue #548): a phase shift — a fork, or a switch of the whole job — where the server
// takes one, else why not; a suggested one in one click; an admin's phase-shift settings below the questions. The forks
// made from a question show on its card, with their status and a link (issue #570).
// A parked job's question is not here: it is in Parked, with its job, and comes back when the job is picked up with
// it still open (issue #565).
// The question, the levels' answers and reasons are rendered as Markdown, sanitized; a long question shows its summary
// first, the rest behind Show all (issue #569).
// Why it came to a person (issue #679): one sentence at the top of the card, with what the level recommends, and the
// list filters by that reason, each with its count. Use answer names whose answer it uses.
// The view keeps the reading position: an arrival, a question leaving, a card growing never moves the
// card in view or the answer being typed; an arrival below the screen shows as "N new below".
import { Archive, ArrowDown, Check, ChevronRight, Lock, MessageCircleQuestion, RotateCw, Send, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Textarea } from '@/components/ui/textarea';
import { Confirm } from '@/components/confirm';
import { Countdown, JobTitle } from '@/components/job';
import { CardText, Markdown } from '@/components/markdown';
import { Empty, Panel } from '@/components/panel';
import { RaisedOn } from '@/components/raised-by';
import { StatusBadge } from '@/components/status';
import { between, clock } from '@/model/format';
import type { EscalationReason, QuestionAttempt, QuestionView } from '@/model/wire';
import { unseenByOwner } from '@/model/questions';
import { REASON_LABELS, reasonCounts, reasonSentence, recommendationLine, stageName, trailReason } from '@/model/escalation';
import { questionOrder } from '@/model/priority';
import { HighTag } from '@/components/priority';
import { useReadingPosition } from '@/lib/reading-position';
import { act, actFor, markSeen, refreshQuestions, useHopper } from '@/store';
import { useCanAdmin, useCanOperate, useJobIndex, useQuestions } from '@/store/selectors';
import { ParkButton } from '@/views/overview/lanes';
import { PhaseShiftSettingsPanel, QuestionForks, ShiftActions } from '@/views/phase-shifts';

const Mark = ({ ok }: { ok: boolean }) => <span className={ok ? 'text-ok' : 'text-bad'}>{ok ? '✓' : '✗'}</span>;

/** `onUse`: sends the attempt's answer (a level's recommendation) as the owner's, at once; `busy` while any answer is in flight. */
function Attempt({ a, onUse, busy }: { a: QuestionAttempt; onUse?: (answer: string) => void; busy?: boolean }) {
  return (
    <div className="space-y-1 border-l-2 border-border py-1 pl-3 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge status={a.tier} tone={a.tier === 'human' ? 'question' : 'muted'} />
        {a.role && <span className="text-muted-foreground">{a.role}</span>}
        {a.model && <span className="font-mono text-muted-foreground">{a.model}</span>}
        {a.machine && <span className="text-muted-foreground" title={`picked: ${a.machine.why}`}>on <span className="font-mono">{a.machine.id}</span> ({a.machine.why})</span>}
        <StatusBadge status={a.outcome} />
        {a.confident != null && <span>confident <Mark ok={a.confident} /></span>}
        {a.escalate != null && <span>escalate <Mark ok={a.escalate} /></span>}
        {(a.riskRules ?? []).map((r) => <StatusBadge key={r} status={r} tone="bad" />)}
        {a.finishedAt && <span className="num text-muted-foreground">{between(a.startedAt, a.finishedAt)}</span>}
      </div>
      {a.answer && <div className="rounded-md bg-muted/50 p-2"><CardText text={a.answer} /></div>}
      {a.reason && <Markdown text={trailReason(a.reason)} className="text-muted-foreground" />}
      {a.error && <div className="text-bad">{a.error}</div>}
      {onUse && a.answer && <Button size="sm" variant="outline" disabled={busy} onClick={() => onUse(a.answer!)} title="Send this answer to the job now">Use {stageName(a.tier)}'s answer</Button>}
    </div>
  );
}

/** Why the question came to a person and what the level recommends: the top of its card, nothing to expand (issue #679). */
function ReasonBanner({ q }: { q: QuestionView }) {
  const said = recommendationLine(q.escalation);
  const guard = q.escalation?.reason === 'guard';
  return (
    <div data-slot="escalation-reason" className={`space-y-0.5 rounded-md border p-2.5 text-sm ${guard ? 'border-bad/40 bg-bad/5' : 'border-question/30 bg-question/5'}`}>
      <div className="font-medium">{reasonSentence(q.escalation)}</div>
      {said && <div className="text-muted-foreground">{said}</div>}
    </div>
  );
}

function QuestionCard({ q }: { q: QuestionView }) {
  const job = useJobIndex().get(q.jobId);
  const role = useHopper((s) => s.user?.role);
  const canAnswer = useCanOperate();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  // Set at once, before the re-render that disables the buttons: a second click in between sends nothing.
  const inFlight = useRef(false);
  const [sent, setSent] = useState<{ answer: string; error?: string } | null>(null);
  const lines = q.recentOutput.split('\n');
  /** The one answer route, for Send answer, Use answer and Retry. */
  const submit = async (answer: string) => {
    const text = answer.trim();
    if (!text || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setSent(null);
    const r = await actFor(`/ui/api/questions/${encodeURIComponent(q.id)}/answer`, { answer: text }, 'Answer sent');
    if (r.ok) setDraft('');
    setSent(r.ok ? { answer: text } : { answer: text, error: r.error });
    inFlight.current = false;
    setSending(false);
    refreshQuestions().catch(() => {});
  };
  const send = () => submit(draft);
  const end = async (how: 'close' | 'dismiss') => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    if (await act(`/ui/api/questions/${encodeURIComponent(q.id)}/${how}`, {}, how === 'close' ? 'Question closed' : 'Question dismissed')) setDraft('');
    inFlight.current = false;
    setSending(false);
    refreshQuestions().catch(() => {});
  };
  const movedOn = job && (job.status !== 'waiting_answer' || job.questionId !== q.id);
  return (
    <Panel title={q.tier === 'human' ? 'For you' : `With ${q.tier}`} icon={MessageCircleQuestion} className={q.high ? 'border-warn/60' : q.tier === 'human' ? 'border-question/40' : ''}
      action={<span className="num text-xs text-muted-foreground">asked {clock(q.createdAt)} <RaisedOn raisedBy={q.raisedBy} className="align-bottom" />{q.tier === 'human' && <> · notified {q.notifyCount}×</>}
        {q.tier === 'human' && q.expiresAt && <> · expires <Countdown iso={q.expiresAt} className="text-warn" /></>}</span>}
      bodyClassName="space-y-3">
      {!job && q.high && <HighTag priority={q.priority} className="self-start" />}
      {job && <div className="flex items-start gap-2"><JobTitle job={job} className="flex-1" />
        {movedOn && <StatusBadge status={`job ${job.status}`} tone="warn" label={`job moved on: ${job.status}`} />}
        {!movedOn && <ParkButton job={job} />}</div>}
      {q.tier === 'human' && <ReasonBanner q={q} />}
      <div data-slot="question-text" className="rounded-md border-l-2 border-question bg-question/5 p-3 text-sm"><CardText text={q.text} tldr={q.tldr?.text} /></div>
      <QuestionForks q={q} />
      {q.lapsesAt && <div data-slot="lapses" className="text-xs text-warn">Claude Code denies this by itself <Countdown iso={q.lapsesAt} /> unless it is answered first.</div>}
      <Collapsible>
        <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />recent output ({Math.min(40, lines.length)} of {lines.length} lines)
        </CollapsibleTrigger>
        <CollapsibleContent><pre className="mt-2 max-h-80 overflow-auto rounded-md bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">{lines.slice(-40).join('\n')}</pre></CollapsibleContent>
      </Collapsible>
      {q.attempts.length > 0 && <div className="space-y-1.5"><div className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Escalation trail</div>{q.attempts.map((a, i) => <Attempt key={i} a={a} busy={sending} onUse={canAnswer && q.tier === 'human' && a.role !== 'human' && a.answer ? (answer) => void submit(answer) : undefined} />)}</div>}
      {canAnswer && (
        <div className="space-y-2">
          <Textarea rows={3} value={draft} disabled={sending} placeholder="Answer to type into the job (Ctrl/Cmd+Enter sends)"
            onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }} />
          {sent && (
            <div data-slot="answer-result" className={`flex flex-wrap items-center gap-2 text-sm ${sent.error ? 'text-bad' : 'text-ok'}`}>
              {sent.error
                ? <>Not sent: {sent.error}<Button size="sm" variant="outline" disabled={sending} onClick={() => void submit(sent.answer)}><RotateCw />Retry</Button></>
                : <><Check className="size-4" />Answer sent</>}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void send()} disabled={sending || !draft.trim()}><Send />{sending ? 'Sending…' : 'Send answer'}</Button>
            <Confirm title="Close this question without answering?" description="The job continues on its own judgement, or fails."
              action="Close question" onConfirm={() => void end('close')}>
              <Button variant="outline" disabled={sending} title="End the question without answering"><X />Close</Button>
            </Confirm>
            <Confirm title="Dismiss this question?" description="It needs no action any more. Nothing is typed into the job; a job still waiting on it is cancelled."
              action="Dismiss question" onConfirm={() => void end('dismiss')}>
              <Button variant="ghost" disabled={sending} title="Drop a question that needs no action"><Archive />Dismiss</Button>
            </Confirm>
          </div>
          {!movedOn && <ShiftActions q={q} busy={sending} />}
        </div>
      )}
      {!canAnswer && (
        <div data-slot="login-notice" className="flex flex-wrap items-center gap-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          <Lock className="size-4" />Your role ({role}) cannot answer, close or dismiss questions; an operator or admin can.
        </div>
      )}
    </Panel>
  );
}

/** The reasons to filter by, each with its count; shown when any question came to a person with a reason. */
function ReasonFilter({ counts, total, value, onChange }: {
  counts: { reason: EscalationReason; count: number }[]; total: number; value: EscalationReason | undefined; onChange(v: EscalationReason | undefined): void;
}) {
  if (counts.length === 0) return null;
  const chip = (key: string, label: string, count: number, v: EscalationReason | undefined) => (
    <Button key={key} size="sm" variant={value === v ? 'default' : 'outline'} aria-pressed={value === v} onClick={() => onChange(v)}>
      {label}<span className="num ml-1 opacity-70">{count}</span>
    </Button>
  );
  return (
    <div data-slot="reason-filter" className="flex flex-wrap items-center gap-1.5" aria-label="Filter by why a question came to you">
      {chip('all', 'All', total, undefined)}
      {counts.map((c) => chip(c.reason, REASON_LABELS[c.reason], c.count, c.reason))}
    </div>
  );
}

export function Questions() {
  const questions = useQuestions();
  const [reason, setReason] = useState<EscalationReason | undefined>(undefined);
  const counts = useMemo(() => reasonCounts(questions), [questions]);
  // A filter whose last question left shows all again.
  const active = reason && counts.some((c) => c.reason === reason) ? reason : undefined;
  const ordered = useMemo(() => questionOrder(active ? questions.filter((q) => q.escalation?.reason === active) : questions), [questions, active]);
  const list = useRef<HTMLDivElement>(null);
  const { below, showBelow } = useReadingPosition(list, 'question', ordered.map((q) => q.id), questions);
  // Seen is shared state: only a session that can act on the questions marks them.
  const canAnswer = useCanOperate();
  const canAdmin = useCanAdmin();
  const unseen = questions.filter(unseenByOwner).map((q) => q.id).join(',');
  useEffect(() => { if (canAnswer && unseen) void markSeen(unseen.split(',')); }, [canAnswer, unseen]);
  return (
    <div ref={list} className="space-y-3 [overflow-anchor:none]">
      <ReasonFilter counts={counts} total={questions.length} value={active} onChange={setReason} />
      {ordered.length
        ? ordered.map((q) => <div key={q.id} data-question={q.id}><QuestionCard q={q} /></div>)
        : <Panel title="Questions" icon={MessageCircleQuestion}><Empty>no open questions</Empty></Panel>}
      {canAdmin && <PhaseShiftSettingsPanel />}
      {below > 0 && (
        <Button data-slot="new-questions" size="sm" onClick={showBelow} className="fixed bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-full shadow-lg">
          <ArrowDown />{below} new below
        </Button>
      )}
    </div>
  );
}
