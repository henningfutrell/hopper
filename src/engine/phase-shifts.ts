// The engine's side of phase shifts (issue #548, design.md "Phase shifts"). A question is answered with Research this
// or Propose this, as a fork or a switch. A fork is a new job, accepted at once (a person or an allowed level asked for
// it), with the parent's spec, priority and work tree, asked for the one special job; it has no source of its own, so
// the sync never reports it to the parent's item. Its parent waits on its question, or is parked where the settings say
// so and its executor can park. A switch answers the question with what the job is to do now and moves the job into the
// phase. Each is one transaction with the question; the settings are read at each shift, so a change applies at once.
// A fork shows on its question (issue #570), and a second fork of its kind waits until it ends. Answered without it,
// the question's answer is kept on the fork, which is told it at its next start; its parent is told the fork still runs.
import { REVIEW_SECTIONS, backToWorkBrief, DEFAULT_PHASE_SHIFT_SETTINGS, forkAnswer, forkAnsweredBrief, forkRunningBrief, phaseOf, switchBrief, thenChoices,
  type ForkOf, type Job, type JobPhase, type JobSpec, type PhaseShiftSettings, type PhaseShiftSettingsView, type Question, type QuestionShifts,
  type ReviewItem, type ReviewKind, type ShiftMode } from '../domain/types.ts';
import { nowIso, priorityTagOf, type EngineContext } from './context.ts';
import { EngineError } from './errors.ts';
import { parkRefusal, recordPark, releaseParked } from './park.ts';
import { forksOf, running } from '../questions/stale.ts';

/** Who shifts: a person (by name), or an escalation level the settings allow. */
export interface ShiftBy { person: string }
export interface ShiftByLevel { level: string }

export interface ShiftRequest { to: ReviewKind; mode?: ShiftMode; note?: string }
export interface ShiftResult { question: Question; job: Job; fork?: Job }

export type PhaseShiftSettingsPatch = Partial<PhaseShiftSettings>;
export type PhaseShiftSettingsEdit = { ok: true; view: PhaseShiftSettingsView } | { ok: false; error: string };

export interface PhaseShifts {
  settings(): PhaseShiftSettings;
  view(levels: readonly string[]): PhaseShiftSettingsView;
  /** Save the parts `patch` names; a level that is not an escalation level now is refused. */
  edit(patch: PhaseShiftSettingsPatch, levels: readonly string[]): PhaseShiftSettingsEdit;
  /** What the question offers now: the modes the server takes, or why none. */
  offered(q: Question): QuestionShifts;
  /** A person shifts a job from its question. Throws EngineError: not_found, conflict. */
  shift(questionId: string, req: ShiftRequest, by: ShiftBy): ShiftResult;
  /** Inside the question service's tx: a level's suggestion, made when the settings allow the level. The mode made, or undefined. */
  byLevel(q: Question, suggest: { to: ReviewKind; note?: string }, level: string): ShiftMode | undefined;
}

const noun = (kind: ReviewKind): string => REVIEW_SECTIONS[kind].noun;

export function createPhaseShifts(c: EngineContext): PhaseShifts {
  const { store } = c;
  const settings = (): PhaseShiftSettings => store.settings.getPhaseShifts() ?? DEFAULT_PHASE_SHIFT_SETTINGS;
  const view = (levels: readonly string[]): PhaseShiftSettingsView => ({ ...settings(), choices: { levels: [...levels] } });

  /** The job waiting on the question, on it or parked on it. */
  const waitingJob = (q: Question): Job | undefined => {
    const job = store.jobs.get(q.jobId);
    return job && (job.status === 'waiting_answer' || job.status === 'parked') && job.questionId === q.id ? job : undefined;
  };

  /** Why the question takes no shift; given `to` and `mode`, why it takes no such shift: a fork of its kind still runs (issue #570). */
  function refusal(q: Question, to?: ReviewKind, mode?: ShiftMode): string | undefined {
    if (q.status !== 'open') return `question ${q.id} is ${q.status}: only an open question can shift its job`;
    const job = waitingJob(q);
    if (!job) return `its job ${q.jobId} no longer waits on it`;
    if (!c.executors.get(job.spec.executor)?.reviews) return `its executor ${job.spec.executor} cannot write a research report or a proposal`;
    const forked = mode === 'fork' ? forksOf(store, q).find((f) => f.forkOf!.kind === to && running(f)) : undefined;
    if (forked) return `a ${noun(to!)} forked from it still runs: job ${forked.id}`;
    return undefined;
  }

  /** Inside a tx: the same job, in its session, moves into `to`; the question is answered with what it is to do now. */
  function switchJob(q: Question, job: Job, to: ReviewKind, note: string | undefined, by: string, stage: string): Job {
    const from = phaseOf(job);
    c.questions.settleWith(q.id, switchBrief(to, note), stage, `phase shift: ${noun(to)} first, in the same job${note ? `: ${note}` : ''}`);
    const next = store.jobs.update(job.id, { phase: to, shift: { to, questionId: q.id, ...(note ? { note } : {}), by, at: nowIso(c) } });
    store.events.append({
      type: 'job.phase_changed', jobId: job.id, questionId: q.id,
      data: { from, to, reason: note ?? `${by} switched the job to a ${noun(to)}`, mode: 'switch', questionId: q.id, ...(note ? { note } : {}), by },
    });
    return next;
  }

  /** Inside a tx: a new job asked for `to` about the aspect, with the parent's spec, priority and work tree. */
  function forkJob(q: Question, parent: Job, to: ReviewKind, note: string | undefined, by: string): { fork: Job; parked: boolean } {
    const { proposal: _p, research: _r, ...rest } = parent.spec;
    const spec: JobSpec = { ...rest, [REVIEW_SECTIONS[to].specFlag]: true };
    const source = parent.source ?? parent.forkOf?.source;
    const forkOf: ForkOf = {
      jobId: parent.id, questionId: q.id, kind: to, ...(note ? { note } : {}), question: q.text,
      ...(source ? { source: { source: source.source, key: source.key, kind: source.kind, ...(source.url ? { url: source.url } : {}), ...(source.title ? { title: source.title } : {}), ...(source.repo ? { repo: source.repo } : {}) } } : {}),
    };
    const created = store.jobs.create(spec, parent.priority);
    store.events.append({ type: 'job.queued', jobId: created.id, data: { spec, priority: parent.priority, forkOf: { jobId: parent.id, questionId: q.id, kind: to } } });
    // A person or an allowed level asked for it: it passes the queue gate at once, pinned where its parent's work tree is.
    const fork = store.jobs.update(created.id, { accepted: true, forkOf, phase: to });
    store.jobs.update(parent.id, { forks: [...(parent.forks ?? []), fork.id] });
    const park = settings().forkParent === 'park' && parent.status === 'waiting_answer' && parkRefusal(c, parent) === undefined;
    if (park) recordPark(c, store.jobs.get(parent.id)!, 'waiting_answer');
    store.events.append({
      type: 'job.forked', jobId: parent.id, questionId: q.id,
      data: { forkId: fork.id, to, mode: 'fork', questionId: q.id, ...(note ? { note } : {}), by, parent: park || parent.status === 'parked' ? 'parked' : 'waiting', ...priorityTagOf(c, parent.id) },
    });
    return { fork, parked: park };
  }

  return {
    settings,
    view,
    edit(patch, levels) {
      const was = settings();
      const next: PhaseShiftSettings = { ...was, ...patch };
      const unknown = next.levels.filter((l) => !levels.includes(l));
      if (unknown.length > 0) return { ok: false, error: `not an escalation level: ${unknown.join(', ')} (the escalation levels are ${levels.join(', ') || 'none'})` };
      if (new Set(next.levels).size !== next.levels.length) return { ok: false, error: 'a level is named twice' };
      store.tx(() => {
        store.settings.setPhaseShifts(next);
        if (JSON.stringify(was) !== JSON.stringify(next)) store.events.append({ type: 'phase_shifts.settings_changed', data: { from: was, to: next } });
      });
      return { ok: true, view: view(levels) };
    },
    offered(q) {
      const why = refusal(q);
      const defaultMode = settings().defaultMode;
      return why ? { modes: [], defaultMode, refusal: why } : { modes: ['fork', 'switch'], defaultMode };
    },
    shift(questionId, req, by) {
      let parked: Job | undefined;
      const result = store.tx((): ShiftResult => {
        const q = store.questions.get(questionId);
        if (!q) throw new EngineError('not_found', `question ${questionId} not found`);
        const mode = req.mode ?? settings().defaultMode;
        const why = refusal(q, req.to, mode);
        if (why) throw new EngineError('conflict', why);
        const job = waitingJob(q)!;
        if (mode === 'switch') {
          const next = switchJob(q, job, req.to, req.note, by.person, 'human');
          return { question: store.questions.get(q.id)!, job: next };
        }
        const f = forkJob(q, job, req.to, req.note, by.person);
        if (f.parked) parked = store.jobs.get(job.id);
        return { question: store.questions.get(q.id)!, job: store.jobs.get(job.id)!, fork: f.fork };
      });
      if (parked) void releaseParked(c, parked);
      return result;
    },
    byLevel(q, suggest, level) {
      const s = settings();
      if (!s.levels.includes(level) || refusal(q, suggest.to, s.defaultMode)) return undefined;
      const job = waitingJob(q)!;
      if (s.defaultMode === 'switch') switchJob(q, job, suggest.to, suggest.note, level, level);
      else {
        const f = forkJob(q, job, suggest.to, suggest.note, level);
        if (f.parked) setImmediate(() => void releaseParked(c, store.jobs.get(job.id)!));
      }
      return s.defaultMode;
    },
  };
}

/**
 * Inside the review service's tx: a fork's item was decided (issue #548). Accepted, its result answers the parent's
 * question while that is still open; rejected, the question stays open and waits for a person again.
 */
export function resolveFork(c: EngineContext, fork: Job, p: ReviewItem): void {
  const f = fork.forkOf!;
  const q = c.store.questions.get(f.questionId);
  const accepted = p.status === 'accepted';
  const was = q?.status ?? 'missing';
  const delivered = accepted && q?.status === 'open' && c.questions.settleWith(q.id, forkAnswer(p, f), `fork:${fork.id}`, `the ${noun(p.kind)} forked from this question was accepted`) !== undefined;
  // `question`: its status at the decision (issue #570) — an answered one is why an acceptance delivered nothing.
  c.store.events.append({ type: 'job.fork_resolved', jobId: f.jobId, questionId: f.questionId, data: { forkId: fork.id, kind: p.kind, questionId: f.questionId, decision: accepted ? 'accept' : 'reject', delivered, question: was } });
  // Not answered by it: the question waits on a person again, its timeout from now.
  if (!delivered && q?.status === 'open') setImmediate(() => c.questions.unparked(q.id));
}

/**
 * Inside the review service's tx: the item of a phase a question switched the job to was decided (issue #548).
 * Accepted, the job does what the person picked: back to work with it as context, on to a proposal (from research),
 * or it ends (`end`: false, the caller finishes it). Rejected, it goes back to work, told so. True when the job was
 * re-queued here.
 */
export function afterSwitch(c: EngineContext, job: Job, p: ReviewItem, requeue: (job: Job, brief: string, reason: string) => void, moveOnBrief: (p: ReviewItem, next: ReviewKind) => string): boolean {
  const then = p.status === 'accepted' ? p.signOff?.then ?? 'work' : 'work';
  if (then === 'end') return false;
  const to: JobPhase = then === 'proposal' && thenChoices(p.kind).includes('proposal') ? 'proposal' : 'work';
  const how = p.status === 'accepted' ? 'accepted' : 'rejected';
  const next = c.store.jobs.update(job.id, to === 'work' ? { phase: 'work', shift: undefined } : { phase: to, shift: { ...job.shift!, to } });
  const reason = to === 'work' ? `${noun(p.kind)} ${how}: back to work` : `${noun(p.kind)} ${how}: on to a ${noun(to)}`;
  c.store.events.append({ type: 'job.phase_changed', jobId: job.id, data: { from: p.kind, to, reason, ...(p.signOff?.by ? { by: p.signOff.by } : {}) } });
  requeue(next, to === 'work' ? backToWorkBrief(p) : moveOnBrief(p, to), reason);
  return true;
}

/**
 * Inside the tx that settles a question (issue #570): answered without its forks, each still running keeps the answer,
 * to be told it at its next start. What the parent is told of them beside its answer, or undefined when none runs.
 */
export function forksOnAnswered(c: EngineContext, q: Question): string | undefined {
  const by = q.answeredBy ?? 'human';
  const forks = forksOf(c.store, q).filter((f) => running(f) && by !== `fork:${f.id}`);
  for (const f of forks) c.store.jobs.update(f.id, { forkOf: { ...f.forkOf!, answered: { answer: q.answer ?? '', by, at: nowIso(c) } } });
  return forks.length > 0 ? forks.map((f) => forkRunningBrief(f.id, f.forkOf!)).join('\n') : undefined;
}

/**
 * At a fork's start (issue #570): its question answered without it and the fork not told yet. A fresh start is told by
 * its brief (forkBrief); a resume, before what it resumes with. Marks it told. The message to resume with.
 */
export function forkResume(c: EngineContext, job: Job, message: string | undefined): string | undefined {
  const f = job.forkOf;
  if (!f?.answered || f.answered.told) return message;
  c.store.jobs.update(job.id, { forkOf: { ...f, answered: { ...f.answered, told: true } } });
  return message === undefined ? undefined : `${forkAnsweredBrief(f)}\n\n${message}`;
}
