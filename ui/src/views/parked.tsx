// Parked (issue #565): the parked jobs, out of Questions, to pick up later. One compact row per job — its issue title
// and number, the machine it resumes on, how long it has been parked, its open question's first line, and whether its
// agent session resumes or it starts fresh —, high-priority jobs first, then the longest parked on top. Expanded, the
// full question and, where the session may act, an answer box: Answer and pick up sends the answer and picks the job up
// in one step. Pick up (`POST /ui/api/jobs/:id/requeue`) and Cancel act on the row; a viewer reads only. A job picked
// up with its question still open waits on it again, and the question is back in Questions.
import { ChevronRight, CirclePause, Play } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Confirm } from '@/components/confirm';
import { JobTitle, Since } from '@/components/job';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { machineName, parkedOrder, startsFresh } from '@/model/board';
import { goalOf } from '@/model/job';
import { firstLine } from '@/model/questions';
import type { Job, QuestionView } from '@/model/wire';
import { act, actFor, refreshQuestions, useHopper } from '@/store';
import { useCanOperate, useJobBoard } from '@/store/selectors';
import { CancelButton, PickUpButton } from '@/views/overview/lanes';

/** The answer box of an expanded row: the answer is sent, then the job picked up; a fresh start is confirmed first. */
function AnswerAndPickUp({ job, q }: { job: Job; q: QuestionView }) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const fresh = startsFresh(job);
  const submit = async () => {
    const answer = draft.trim();
    if (!answer || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    // The answer is kept on the parked job; a pick up that fails after it leaves the job parked, answered.
    const sent = await actFor(`/ui/api/questions/${encodeURIComponent(q.id)}/answer`, { answer });
    if (sent.ok && await act(`/ui/api/jobs/${job.id}/requeue`, fresh ? { freshSession: true } : {}, 'Answered and picked up')) setDraft('');
    inFlight.current = false;
    setBusy(false);
    refreshQuestions().catch(() => {});
  };
  const button = <Button size="sm" disabled={busy || !draft.trim()} onClick={fresh ? undefined : () => void submit()}><Play />{busy ? 'Sending…' : 'Answer and pick up'}</Button>;
  return (
    <div className="space-y-2">
      <Textarea rows={3} value={draft} disabled={busy} placeholder="Answer, then pick the job up (Ctrl/Cmd+Enter)"
        onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (!fresh && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); } }} />
      {fresh
        ? <Confirm title="Answer and pick up with a fresh session?" action="Answer and start fresh" onConfirm={() => void submit()}
            description={<>No agent session was recorded for “{goalOf(job)}”, so it cannot resume where it stopped. It starts a fresh session in its kept work tree, told its task, its question and your answer. It has none of the earlier session&apos;s history.</>}>
            {button}
          </Confirm>
        : button}
    </div>
  );
}

function ParkedRow({ job, q }: { job: Job; q: QuestionView | undefined }) {
  const machines = useHopper((s) => s.machines);
  const canOperate = useCanOperate();
  const [open, setOpen] = useState(false);
  const answered = job.pendingAnswer !== undefined && job.parked?.from === 'waiting_answer';
  return (
    <div data-parked-job={job.id} className="space-y-1 px-4 py-2.5">
      <div className="flex items-start gap-2">
        {q
          ? <Button variant="ghost" size="icon-xs" aria-label={open ? 'Hide the question' : 'Show the question'} aria-expanded={open} onClick={() => setOpen(!open)} className="mt-0.5 text-muted-foreground">
              <ChevronRight className={open ? 'rotate-90 transition-transform' : 'transition-transform'} />
            </Button>
          : <span className="w-6 shrink-0" />}
        <JobTitle job={job} className="flex-1" />
        <PickUpButton job={job} />
        <CancelButton job={job} />
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-8 text-xs text-muted-foreground">
        {job.resumeOn && <span>on {machineName(job.resumeOn, machines)}</span>}
        <span data-slot="parked-since">parked <Since iso={job.parked?.at ?? job.updatedAt} /> ago</span>
        <span data-slot="resumes" title={job.agentSession ? 'Picked up, its agent session resumes where it stopped.' : 'No agent session was recorded: picked up, it starts a fresh one in its kept work tree.'}>
          {job.agentSession ? 'resumes its session' : 'starts fresh'}
        </span>
        {answered && <StatusBadge status="answered" tone="ok" title="Answered: picked up, it resumes with the answer." />}
      </div>
      {q && !open && <div data-slot="question-line" className="truncate pl-8 text-xs text-question" title={q.text}>{firstLine(q.text)}</div>}
      {q && open && (
        <div className="space-y-2 pt-1 pl-8">
          <pre className="rounded-md border-l-2 border-question bg-question/5 p-3 font-mono text-sm whitespace-pre-wrap">{q.text}</pre>
          {canOperate && !answered && <AnswerAndPickUp job={job} q={q} />}
        </div>
      )}
    </div>
  );
}

export function Parked() {
  const { parked } = useJobBoard();
  const threshold = useHopper((s) => s.highPriority);
  const questions = useHopper((s) => s.questions);
  const rows = useMemo(() => parkedOrder(parked, threshold), [parked, threshold]);
  const openQuestion = (job: Job) => questions.find((q) => q.id === job.questionId && q.status === 'open');
  return (
    <Panel title="Parked" icon={CirclePause} count={rows.length || ''} list bodyClassName="divide-y p-0">
      {rows.length ? rows.map((job) => <ParkedRow key={job.id} job={job} q={openQuestion(job)} />) : <Empty>no parked jobs</Empty>}
    </Panel>
  );
}
