// Parked (issue #565): the parked jobs, out of Questions, to pick up later. One compact row per job — its issue title
// and number, the machine it resumes on, how long it has been parked, its open question's first line, and whether its
// agent session resumes or it starts fresh —, high-priority jobs first, then the longest parked on top. Expanded, the
// full question and, where the session may act, an answer box: Answer and pick up sends the answer and picks the job up
// in one step. A question asked on its issue thread (issue #435) says so, with Post on the issue while it is held for review. A job auto-park parked (issue #650) says why, and its answer alone picks it up: its box only answers. Pick up (`POST /ui/api/jobs/:id/requeue`) and Cancel act on the row; a viewer reads only. A job picked
// up with its question still open waits on it again, and the question is back in Questions. A job with a checkpoint
// (issue #921) says when it was taken, and Resume elsewhere, confirmed, picks it up on any machine from it; with its
// question open, the answer comes first. The answer box is the one question form (issue #1169). A row says who parked the
// job and why (issue #2167), and, for a job parked on a proposal or research report, that item's first line. A job on a
// person (issue #2415) says what it waits on and what picks it up; auto-parked, it has no Pick up — picked up, it would only
// park again — but Answer, or its item's card inline with a link to its section.
import { ChevronRight, CirclePause, MoveRight, Play } from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Confirm } from '@/components/confirm';
import { JobTitle, Since } from '@/components/job';
import { Empty, Panel } from '@/components/panel';
import { QuestionForm } from '@/components/question-form';
import { StatusBadge } from '@/components/status';
import { canResumeElsewhere, machineName, parkedOrder, startsFresh } from '@/model/board';
import { answerPicksUp, pickUpRefused, type PersonWait } from '@/model/auto-park';
import { goalOf } from '@/model/job';
import { firstLine } from '@/model/questions';
import { CardText, InlineMarkdown } from '@/components/markdown';
import type { Job, QuestionView, ReviewItemView, ReviewKind } from '@/model/wire';
import { REVIEW_UI } from '@/model/reviews';
import { ParkedBy } from '@/views/parked-items';
import { act, actFor, refreshQuestions, useHopper } from '@/store';
import { useCanOperate, useJobBoard } from '@/store/selectors';
import { CancelButton, PickUpButton, personWaitText, usePersonWait } from '@/views/dashboard/lanes';
import { ItemCard } from '@/views/review-section';
import { ThreadState } from '@/components/thread-ask';

/** The answer box of an expanded row: the answer is sent, then the job picked up; a fresh start is confirmed first. */
function AnswerAndPickUp({ job, q }: { job: Job; q: QuestionView }) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const fresh = startsFresh(job);
  // Auto-parked (issue #650): the answer re-queues it on the daemon; no pick up follows.
  const answerOnly = answerPicksUp(job);
  const submit = async () => {
    const answer = draft.trim();
    if (!answer || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    // The answer is kept on the parked job; a pick up that fails after it leaves the job parked, answered.
    const sent = await actFor(`/ui/api/questions/${encodeURIComponent(q.id)}/answer`, { answer }, answerOnly ? 'Answered: the job goes back in the queue' : undefined);
    if (sent.ok && (answerOnly || await act(`/ui/api/jobs/${job.id}/requeue`, fresh ? { freshSession: true } : {}, 'Answered and picked up'))) setDraft('');
    inFlight.current = false;
    setBusy(false);
    refreshQuestions().catch(() => {});
  };
  const label = busy ? 'Sending…' : answerOnly ? 'Answer' : 'Answer and pick up';
  return (
    <QuestionForm name="answer" title="Your answer" text={draft} onText={setDraft} busy={busy}
      placeholder={answerOnly ? 'Answer: the job goes back in the queue (Ctrl/Cmd+Enter)' : fresh ? 'Answer, then pick the job up with a fresh session' : 'Answer, then pick the job up (Ctrl/Cmd+Enter)'}
      submit={<><Play />{label}</>} canSubmit={!!draft.trim()} onSubmit={() => void submit()}
      {...(fresh ? {
        confirm: (button: ReactNode) => (
          <Confirm title="Answer and pick up with a fresh session?" action="Answer and start fresh" onConfirm={() => void submit()}
            description={<>No agent session was recorded for “{goalOf(job)}”, so it cannot resume where it stopped. It starts a fresh session in its kept work tree, told its task, its question and your answer. It has none of the earlier session&apos;s history.</>}>
            {button}
          </Confirm>
        ),
      } : {})} />
  );
}

/**
 * Resume elsewhere (issue #921): the job is picked up on any machine that can take it, its work tree rebuilt there from
 * its last checkpoint. `waits`: its question is open with no answer, which must come first.
 */
function ResumeElsewhereButton({ job, waits }: { job: Job; waits: boolean }) {
  const machines = useHopper((s) => s.machines);
  const canOperate = useCanOperate();
  const k = job.checkpoint;
  if (!canOperate || !k || !canResumeElsewhere(job)) return null;
  const button = (
    <Button size="xs" variant="outline" disabled={waits} title={waits ? 'Answer its question first: it resumes elsewhere with the answer' : 'Resume on any machine, from its last checkpoint'}>
      <MoveRight />Resume elsewhere
    </Button>
  );
  if (waits) return button;
  const n = k.commits.length;
  return (
    <Confirm title="Resume elsewhere?" action="Resume elsewhere" onConfirm={() => act(`/ui/api/jobs/${job.id}/requeue`, { elsewhere: true }, 'Job picked up: it resumes elsewhere from its checkpoint')}
      description={<>“{goalOf(job)}” resumes its agent session on any machine that can take it, from its checkpoint taken <Since iso={k.at} /> ago on {machineName(k.machineId, machines)}. Its work tree is made again there: the pushed work, then the checkpoint&apos;s changes as uncommitted work{n ? ` (${n} commit${n === 1 ? '' : 's'} not pushed)` : ''}. Work done after the checkpoint is lost.</>}>
      {button}
    </Confirm>
  );
}

/** The first part of the proposal or research report the job waits on (issue #2167), if it has one. */
function useItemHeadline(item: ReviewItemView | undefined, kind: ReviewKind | undefined): string | undefined {
  const type = useHopper((s) => (kind ? s.reviews[kind].type : null));
  if (!item) return undefined;
  const v = item.versions.at(-1)!;
  const first = type?.parts[0]?.[0];
  return (first && v.sections[first]) || v.text;
}

/** What the job waits on a person for, and what picks it up (issue #2415); auto-parked, Pick up would only park it again. */
function WaitsOn({ wait, refused, onAnswer }: { wait: PersonWait; refused: boolean; onAnswer?: () => void }) {
  const { noun, ends } = personWaitText(wait);
  const section = wait === 'question' ? undefined : REVIEW_UI[wait];
  return (
    <div data-slot="waits-on" className="flex flex-wrap items-center gap-x-2 pl-8 text-xs text-question">
      <span>{refused
        ? `Waits on a person for its ${noun}: ${ends} picks it up. Pick up would only park it again.`
        : `Waits on a person for its ${noun}: picked up, it parks again until ${ends} comes.`}</span>
      {refused && onAnswer && <Button size="xs" variant="outline" onClick={onAnswer}><Play />{wait === 'question' ? 'Answer' : 'Decide'}</Button>}
      {section && <a href={`#${section.section}`} className="underline">Open it in {section.label}</a>}
    </div>
  );
}

function ParkedRow({ job, q }: { job: Job; q: QuestionView | undefined }) {
  const machines = useHopper((s) => s.machines);
  const { wait, item, kind } = usePersonWait(job);
  const itemType = useHopper((s) => (kind ? s.reviews[kind].type : null));
  const headline = useItemHeadline(item, kind);
  const canOperate = useCanOperate();
  const [open, setOpen] = useState(false);
  const answered = job.pendingAnswer !== undefined && job.parked?.from === 'waiting_answer';
  const refused = pickUpRefused(job, wait);
  // Auto-parked on its item (issue #2415): the item's card, decided here, picks it up.
  const card = refused && wait && wait !== 'question' && item && itemType ? { kind: wait, item, type: itemType } : undefined;
  const folds = q !== undefined || card !== undefined;
  return (
    <div data-parked-job={job.id} className="space-y-1 px-4 py-2.5">
      <div className="flex items-start gap-2">
        {folds
          ? <Button variant="ghost" size="icon-xs" aria-label={open ? `Hide the ${q ? 'question' : REVIEW_UI[card!.kind].noun}` : `Show the ${q ? 'question' : REVIEW_UI[card!.kind].noun}`} aria-expanded={open} onClick={() => setOpen(!open)} className="mt-0.5 text-muted-foreground">
              <ChevronRight className={open ? 'rotate-90 transition-transform' : 'transition-transform'} />
            </Button>
          : <span className="w-6 shrink-0" />}
        <JobTitle job={job} className="flex-1" />
        <PickUpButton job={job} />
        <ResumeElsewhereButton job={job} waits={(q !== undefined || item !== undefined) && job.pendingAnswer === undefined} />
        <CancelButton job={job} />
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-8 text-xs text-muted-foreground">
        {job.resumeOn && <span>on {machineName(job.resumeOn, machines)}</span>}
        <span data-slot="parked-since">parked <Since iso={job.parked?.at ?? job.updatedAt} /> ago</span>
        <span data-slot="resumes" title={job.agentSession ? 'Picked up, its agent session resumes where it stopped.' : 'No agent session was recorded: picked up, it starts a fresh one in its kept work tree.'}>
          {job.agentSession ? 'resumes its session' : 'starts fresh'}
        </span>
        {job.checkpoint && <span data-slot="checkpoint" title={`Its last checkpoint, taken on ${machineName(job.checkpoint.machineId, machines)}`}>checkpoint <Since iso={job.checkpoint.at} /> ago</span>}
        {answered && <StatusBadge status="answered" tone="ok" title="Answered: picked up, it resumes with the answer." />}
      </div>
      {job.parked?.why && <div data-slot="parked-why" className="pl-8 text-xs text-muted-foreground">{job.parked.why}</div>}
      <ParkedBy parked={job.parked} className="pl-8 text-xs text-muted-foreground" />
      {wait && !answered && <WaitsOn wait={wait} refused={refused} {...(canOperate && folds && !open ? { onAnswer: () => setOpen(true) } : {})} />}
      {kind && headline && <div data-slot="item-line" className="truncate pl-8 text-xs" title={headline}>waits on its {REVIEW_UI[kind].noun}: <InlineMarkdown text={firstLine(headline)} /></div>}
      {q && <ThreadState q={q} className="pl-8" />}
      {q && !open && <div data-slot="question-line" className="truncate pl-8 text-xs text-question" title={q.text}><InlineMarkdown text={firstLine(q.text)} /></div>}
      {q && open && (
        <div className="space-y-2 pt-1 pl-8">
          <div data-slot="question-text" className="rounded-md border-l-2 border-question bg-question/5 p-3 text-sm"><CardText text={q.text} tldr={q.tldr?.text} /></div>
          {canOperate && !answered && <AnswerAndPickUp job={job} q={q} />}
        </div>
      )}
      {card && open && <div data-slot="item-card" className="pt-1 pl-8"><ItemCard kind={card.kind} p={card.item} type={card.type} /></div>}
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
    <Panel title="Parked" icon={CirclePause} count={rows.length || ''} bodyClassName="divide-y p-0">
      {rows.length ? rows.map((job) => <ParkedRow key={job.id} job={job} q={openQuestion(job)} />) : <Empty>no parked jobs</Empty>}
    </Panel>
  );
}
