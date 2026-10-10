// The question pipeline (design.md "Question pipeline"): the escalation levels, lowest first. Each
// level answers the question or escalates it to the next level up; above the top level is the
// owner. An answer is typed into the job unless a risk rule matches, which sends the question to
// the owner whatever level answered, or auto-answer holds it (issue #632, ./auto-answer.ts): the consequential
// guard, a high-priority job, auto-answer off, or a confidence below the threshold. A person may correct an auto-answer. First of all, a question whose answer the facts fix (issue #629) is answered
// without a model: an allowed permission dialog, or a person's answer reused; the risk rules still run. Then, before the levels, a question that lists its options is a minor decision
// (issue #550): Jev picks first, and its pick is the answer only when its decision point is active and it is sure. The levels are looked up per question (a live role), and every
// reply is validated here: a level that breaks its contract, fails or times out escalates, it never
// answers.
import type { AnswerByHumanResult, Clock, ConfigRecords, EscalationLevel, QuestionService, UserStore } from '../domain/ports.ts';
import type { Logins } from '../logins/index.ts';
import { jobPriorityTag, type JevFirst, type Question, type QuestionAttempt, type ReviewKind, type ShiftMode } from '../domain/types.ts';
import { answerHold, correctAutoAnswer } from './auto-answer.ts';
import { emitQuestionEvent, type QuestionEventType } from './events.ts';
import { answerFixed, FIXED } from './fixed-answers.ts';
import { askJevFirst, JEV } from './jev-first.ts';
import { forkRuns, openOnEndedJobs, unarmed } from './stale.ts';
import { levelRequest } from './request.ts';
import { REPLY, check } from './results.ts';

export interface QuestionServiceOptions {
  store: UserStore;
  clock: Clock;
  /** The escalation levels now, lowest first; empty: questions go straight to the human. Called per question. */
  levels(): readonly EscalationLevel[];
  /** Ceiling on one level's call. Past it the call is aborted and counts as an error. */
  stageTimeoutMs: number;
  /** Where the rules are read, on every ask. */
  config: ConfigRecords;
  renotifyMs: number;
  humanTimeoutMs: number;
  answerUrl: (questionId: string) => string;
  /** Synchronous, called inside the tx that marks the question answered or closed. */
  onAnswered: (q: Question) => void;
  /** Synchronous, called inside the tx that marks the question expired. */
  onExpired: (q: Question) => void;
  /** Synchronous, called inside the tx that marks the question dismissed. */
  onDismissed: (q: Question) => void;
  /** Synchronous, called inside the tx that records a person's correction of an auto-answer (issue #632): the job gets it. */
  onCorrected: (q: Question) => void;
  /** Where a level's run reports a login it waits on (issue #476): never an answer, and never a question of its own. */
  logins?: Logins;
  /** Jev first (issue #550), asked first about a question that lists its options, and whether the blast-radius gate keeps a machine. Absent: the levels only. */
  minorDecisions?: { first: JevFirst; gated(machineId: string): boolean };
  /**
   * A level suggested a phase shift (issue #548). Inside the tx recording its reply: the engine shifts the job when the
   * phase-shift settings allow the level — the mode it made — else undefined, and the suggestion is the person's to take.
   */
  onShift?: (q: Question, suggest: { to: ReviewKind; note?: string }, by: string) => ShiftMode | undefined;
}

export const HUMAN = 'human';

/** Typed into the job in place of an answer when the owner closes its question. */
export const CLOSED_ANSWER = 'The owner closed this question without answering. Continue on your own judgement; if you cannot, end with HOPPER_FAILED and say why.';

interface Timers { renotify?: NodeJS.Timeout; expiry?: NodeJS.Timeout }

/** The longest delay setTimeout honours; Node fires a longer one after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

export function createQuestionService(o: QuestionServiceOptions): QuestionService {
  const { store, clock } = o;
  const inflight = new Map<string, AbortController>();
  const timers = new Map<string, Timers>();
  const running = new Set<Promise<void>>();
  let stopped = false;
  const iso = () => clock.now().toISOString();

  const emit = (q: Question, type: QuestionEventType, data: Record<string, unknown>) => emitQuestionEvent(store, q, type, data);

  function clearTimers(id: string) {
    const t = timers.get(id);
    if (t) { clearTimeout(t.renotify); clearTimeout(t.expiry); }
    timers.delete(id);
  }

  function abortStage(id: string, reason: string) { inflight.get(id)?.abort(reason); inflight.delete(id); }

  function escalationData(q: Question, target: string, reason: string): Record<string, unknown> {
    // The job's live priority (issue #535): a high-priority question is told apart wherever it goes.
    const base = { target, reason, text: q.text, jobId: q.jobId, ...(q.lapsesAt ? { lapsesAt: q.lapsesAt } : {}), ...jobPriorityTag(store.jobs, store.settings.getPriorityLanes(), q.jobId) };
    if (target !== HUMAN) return base;
    return { ...base, goal: store.jobs.get(q.jobId)?.spec.goal, answerUrl: o.answerUrl(q.id), notifyCount: q.notifyCount };
  }

  // ---- the human stage ------------------------------------------------------------------

  // Its job parked (issue #501): the question stays open and answerable, never expires and is not renotified, until re-queued.
  // A fork of it running (issues #548, #570): the same, until the fork's item is decided (resolveFork re-arms it).

  function expire(id: string) {
    store.tx(() => {
      const q = store.questions.get(id);
      if (!q || q.status !== 'open' || q.tier !== HUMAN || store.jobs.get(q.jobId)?.status === 'parked' || forkRuns(store, q)) return;
      const after = clock.now().getTime() - new Date(q.escalatedToHumanAt ?? q.createdAt).getTime();
      const updated = store.questions.update(id, { status: 'expired' });
      emit(updated, 'question.expired', { after_ms: Math.min(after, o.humanTimeoutMs) });
      clearTimers(id);
      o.onExpired(updated);
    });
  }

  function renotify(id: string) {
    store.tx(() => {
      const q = store.questions.get(id);
      if (!q || q.status !== 'open' || q.tier !== HUMAN || store.jobs.get(q.jobId)?.status === 'parked' || forkRuns(store, q)) return;
      const updated = store.questions.update(id, { notifyCount: q.notifyCount + 1, lastNotifiedAt: iso() });
      emit(updated, 'question.escalated', { ...escalationData(updated, HUMAN, 'still unanswered'), renotify: true });
    });
    armHuman(id);
  }

  /**
   * (Re)arm renotify and expiry from the stored times. Expiry wins a tie. Past the timer limit
   * the expiry timer only re-arms, so a far expiry never fires early.
   */
  function armHuman(id: string) {
    clearTimers(id);
    const q = store.questions.get(id);
    if (!q || q.status !== 'open' || q.tier !== HUMAN || !q.expiresAt || store.jobs.get(q.jobId)?.status === 'parked' || forkRuns(store, q)) return;
    const now = clock.now().getTime();
    const expiresIn = new Date(q.expiresAt).getTime() - now;
    if (expiresIn <= 0) return expire(id);
    const t: Timers = {
      expiry: expiresIn > MAX_TIMER_MS ? setTimeout(() => armHuman(id), MAX_TIMER_MS) : setTimeout(() => expire(id), expiresIn),
    };
    const renotifyIn = Math.max(0, new Date(q.lastNotifiedAt ?? q.createdAt).getTime() + o.renotifyMs - now);
    if (renotifyIn < expiresIn && renotifyIn <= MAX_TIMER_MS) t.renotify = setTimeout(() => renotify(id), renotifyIn);
    timers.set(id, t);
  }

  /** Inside a tx. Moves the question to the human stage and announces it. */
  function toHuman(q: Question, reason: string) {
    const now = clock.now();
    const updated = store.questions.update(q.id, {
      tier: HUMAN, escalatedToHumanAt: now.toISOString(), lastNotifiedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + o.humanTimeoutMs).toISOString(), notifyCount: 1,
    });
    const data = escalationData(updated, HUMAN, reason);
    emit(updated, 'question.escalated', data);
    const { target: _target, ...toHumanData } = data;
    emit(updated, 'question.escalated_to_human', toHumanData);
    queueMicrotask(() => armHuman(q.id));
  }

  // ---- the escalation levels -------------------------------------------------------------

  /** Inside a tx. The question as it is now, if it is still open at `stage`. */
  function stillAt(id: string, stage: string): Question | undefined {
    const q = store.questions.get(id);
    return q && q.status === 'open' && q.tier === stage ? q : undefined;
  }

  /** Inside a tx. A reply that lost the race (human answer, cancel, restart) is logged and ignored. */
  function superseded(id: string, level: EscalationLevel, startedAt: string) {
    if (!store.questions.get(id)) return;
    store.questions.addAttempt(id, {
      tier: level.name, role: 'level', ...(level.model ? { model: level.model } : {}), startedAt, finishedAt: iso(), outcome: 'escalated', reason: 'superseded',
    });
  }

  /** Inside a tx. Moves an open question to `stage` and announces it. */
  function enter(q: Question, stage: string, reason: string): Question {
    const updated = q.tier === stage ? q : store.questions.update(q.id, { tier: stage });
    emit(updated, 'question.escalated', escalationData(updated, stage, reason));
    return updated;
  }

  /** One level's call: aborted by cancel, a human answer, shutdown, or the stage timeout; a throw is an error. */
  async function call<T>(id: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T | { error: string }> {
    const ac = new AbortController();
    inflight.set(id, ac);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<{ error: string }>((resolve) => {
      timer = setTimeout(() => {
        ac.abort('timeout');
        resolve({ error: `timeout after ${o.stageTimeoutMs}ms` });
      }, o.stageTimeoutMs);
    });
    try {
      return await Promise.race([fn(ac.signal).catch((e: unknown) => ({ error: `threw: ${e instanceof Error ? e.message : String(e)}` })), timeout]);
    } finally {
      clearTimeout(timer);
      if (inflight.get(id) === ac) inflight.delete(id);
    }
  }

  /**
   * One level holds the question: its reply is recorded, then the question is answered, goes to the
   * human (a risk rule hit), or climbs on. Returns why it climbs, or undefined when it does not
   * (answered, at the human stage, or taken from this level meanwhile).
   */
  async function ask(id: string, level: EscalationLevel, number: number, of: number, reason: string): Promise<string | undefined> {
    const entered = store.tx((): Question | undefined => {
      const q = store.questions.get(id);
      return q && q.status === 'open' ? enter(q, level.name, reason) : undefined;
    });
    if (!entered) return undefined;
    const { req, rulesNote } = levelRequest(o, entered, number, of, level.name, () => !stopped);
    const startedAt = iso();
    const replied = await call(id, (signal) => level.answer(req, signal));
    if (stopped) return undefined;
    const reply = check(REPLY, 'reply', replied);
    return store.tx((): string | undefined => {
      const q = stillAt(id, level.name);
      if (!q) return void superseded(id, level, startedAt);
      const model = (reply.ok ? reply.value.model : undefined) ?? level.model;
      const machine = reply.ok ? reply.value.machine : undefined;
      const base: QuestionAttempt = { tier: level.name, role: 'level', ...(model ? { model } : {}), ...(machine ? { machine } : {}), startedAt, finishedAt: iso(), outcome: 'escalated' };
      if (!reply.ok) {
        store.questions.addAttempt(id, { ...base, error: reply.error, reason: `error${rulesNote}` });
        return `${level.name} failed: ${reply.error}`;
      }
      const { answer, escalate, reason: why, suggest, confidence } = reply.value;
      const replyFields = { ...(answer === undefined ? {} : { answer }), escalate, reason: `${why}${rulesNote}`, ...(confidence ? { confidence } : {}), ...(suggest ? { suggest } : {}) };
      // A suggested phase shift (issue #548): made by the level where the settings allow it, else shown to the person.
      // A fork leaves the question open for its result, with a person, who may still answer it first.
      const mode = suggest && o.onShift?.(q, suggest, level.name);
      if (mode) {
        store.questions.addAttempt(id, { ...base, ...replyFields, outcome: 'accepted' });
        if (mode === 'fork') toHuman(store.questions.get(id)!, `${level.name} forked ${suggest.to === 'research' ? 'research' : 'a proposal'}: the question waits for its result`);
        return undefined;
      }
      if (suggest && !q.suggestion) store.questions.update(id, { suggestion: { ...suggest, by: level.name } });
      if (escalate || answer === undefined) {
        store.questions.addAttempt(id, { ...base, ...replyFields });
        return `${level.name}: ${why}`;
      }
      // The level answers. The risk rules run on the question and the answer to be typed; a hit goes to the owner, past
      // every level above: no model approves what the rules guard. Then auto-answer (issue #632) may hold it for a person,
      // or, below the threshold, for the next level.
      const { riskRules, hold } = answerHold({ store, q, answer, level: level.name, top: number >= of, confidence, gated: o.minorDecisions?.gated });
      store.questions.addAttempt(id, { ...base, ...replyFields, riskRules, ...(hold ? {} : { outcome: 'accepted' as const }) });
      if (hold) return hold.to === 'next' ? hold.why : void toHuman(q, hold.why);
      const updated = store.questions.update(id, { status: 'answered', answer, answeredBy: level.name });
      emit(updated, 'question.answered', { by: level.name, answer, auto: true, ...(confidence ? { confidence } : {}) });
      o.onAnswered(updated);
      return undefined;
    });
  }

  /** Fixed answers (issue #629), then Jev first (issue #550): true when nothing is left for the levels. */
  const answeredBy = (by: string) => (q: Question) => { emit(q, 'question.answered', { by, answer: q.answer! }); o.onAnswered(q); };
  const jevFirst = (id: string) => (o.minorDecisions ? askJevFirst({ store, ...o.minorDecisions, iso, stopped: () => stopped, answered: answeredBy(JEV) }, id) : Promise.resolve(false));

  async function run(id: string, reason: string): Promise<void> {
    if (stopped) return;
    if (answerFixed({ store, iso, human: HUMAN, toHuman, answered: answeredBy(FIXED) }, id) || await jevFirst(id)) return;
    const levels = [...o.levels()];
    let why: string | undefined = reason;
    for (const [i, level] of levels.entries()) {
      why = await ask(id, level, i + 1, levels.length, why);
      if (why === undefined) return;
    }
    // Past the top level (or no levels at all): the owner.
    store.tx(() => {
      const q = store.questions.get(id);
      if (q && q.status === 'open') toHuman(q, levels.length === 0 ? 'no escalation levels configured' : why);
    });
  }

  function start(id: string, reason: string) {
    const p: Promise<void> = run(id, reason)
      .catch((err: unknown) => console.error(`question ${id}: pipeline failed`, err))
      .finally(() => running.delete(p));
    running.add(p);
  }

  /**
   * Inside a tx. The owner settles an open question — their answer, or the close text — over any level in flight; the
   * caller decides what the job does. `by` (issue #548): a level's switch, or a fork's accepted result, settles it too.
   */
  function settle(q: Question, answer: string, status: 'answered' | 'closed', via?: 'pane', by = HUMAN, reason?: string): Question {
    abortStage(q.id, 'superseded');
    clearTimers(q.id);
    const at = iso();
    store.questions.addAttempt(q.id, {
      tier: by, role: by === HUMAN ? 'human' : by.startsWith('fork:') ? 'fork' : 'level', startedAt: at, finishedAt: at, answer, outcome: 'accepted',
      ...(reason ? { reason } : status === 'closed' ? { reason: 'closed without answering' } : via ? { reason: 'answered in the pane' } : {}),
    });
    const updated = store.questions.update(q.id, { status, answer, answeredBy: by });
    if (status === 'closed') emit(updated, 'question.closed', { answer });
    else emit(updated, 'question.answered', { by, answer, ...(via ? { via } : {}) });
    return updated;
  }

  function byHuman(id: string, answer: string, status: 'answered' | 'closed'): AnswerByHumanResult {
    return store.tx(() => {
      const q = store.questions.get(id);
      if (!q) return { ok: false as const, reason: 'not_found' as const };
      // Idempotent per question (issue #459): the owner's same answer again — a retry, a second click — is the
      // question as it is, with no second attempt, event or resume.
      if (status === 'answered' && q.status === 'answered' && q.answeredBy === HUMAN && q.answer === answer) return { ok: true as const, question: q };
      if (q.status !== 'open') return { ok: false as const, reason: 'not_open' as const };
      const updated = settle(q, answer, status);
      o.onAnswered(updated);
      return { ok: true as const, question: updated };
    });
  }

  return {
    firstStage: () => o.levels()[0]?.name ?? HUMAN,

    handle(id) {
      start(id, 'asked');
    },

    answerByHuman: (id, answer) => byHuman(id, answer, 'answered'),
    closeByHuman: (id) => byHuman(id, CLOSED_ANSWER, 'closed'),

    settleWith(id, answer, by, reason) {
      return store.tx(() => {
        const q = store.questions.get(id);
        if (q?.status !== 'open') return undefined;
        const updated = settle(q, answer, 'answered', undefined, by, reason);
        o.onAnswered(updated);
        return updated;
      });
    },

    dismissByHuman(id) {
      return store.tx(() => {
        const q = store.questions.get(id);
        if (!q) return { ok: false as const, reason: 'not_found' as const };
        if (q.status !== 'open') return { ok: false as const, reason: 'not_open' as const };
        abortStage(id, 'superseded');
        clearTimers(id);
        const updated = store.questions.update(id, { status: 'dismissed' });
        emit(updated, 'question.dismissed', {});
        o.onDismissed(updated);
        return { ok: true as const, question: updated };
      });
    },

    correct: (id, answer, by) => correctAutoAnswer({ store, at: iso(), onCorrected: o.onCorrected }, id, answer, by),

    markSeen(id) {
      const q = store.questions.get(id);
      if (!q) return { ok: false as const, reason: 'not_found' as const };
      return { ok: true as const, question: q.seenAt ? q : store.questions.update(id, { seenAt: iso() }) };
    },

    answeredInPane(id, answer) {
      return store.tx(() => {
        const q = store.questions.get(id);
        return q?.status === 'open' ? settle(q, answer, 'answered', 'pane') : undefined;
      });
    },

    lapsedInPane(id) {
      return store.tx(() => {
        const q = store.questions.get(id);
        if (q?.status !== 'open' || !q.lapsesAt) return undefined;
        abortStage(id, 'superseded');
        clearTimers(id);
        const updated = store.questions.update(id, { status: 'lapsed' });
        emit(updated, 'question.lapsed', { lapsesAt: q.lapsesAt });
        return updated;
      });
    },

    cancel(id) {
      store.tx(() => {
        const q = store.questions.get(id);
        if (!q || q.status !== 'open') return;
        abortStage(id, 'cancel');
        clearTimers(id);
        store.questions.update(id, { status: 'cancelled' });
      });
    },

    // armHuman arms only an open question at the human stage; the expiry written to any other is never read.
    unparked(id) {
      if (store.questions.get(id)?.tier === HUMAN) store.questions.update(id, { expiresAt: new Date(clock.now().getTime() + o.humanTimeoutMs).toISOString(), lastNotifiedAt: iso() });
      armHuman(id);
    },

    // A question at the human stage left with no timers — its fork ended without a decision (issue #570) — waits on a person
    // again, its timeout from now, as when the fork's item is rejected.
    sweep() { for (const q of openOnEndedJobs(store)) this.cancel(q.id); for (const q of unarmed(store, timers, HUMAN)) this.unparked(q.id); },

    recover() {
      // What a restart, or the build before, left open with nothing waiting on it (issue #529): cancelled, not asked again.
      for (const q of openOnEndedJobs(store)) this.cancel(q.id);
      for (const q of store.questions.list({ status: ['open'] })) {
        if (q.tier !== HUMAN) start(q.id, 'restarted after a daemon restart');
        else if (q.expiresAt) armHuman(q.id);
        // Created at the human stage (no levels), the daemon stopped before it was announced.
        else store.tx(() => toHuman(q, 'no escalation levels configured'));
      }
    },

    async stop() {
      stopped = true;
      for (const id of [...inflight.keys()]) abortStage(id, 'shutdown');
      for (const id of [...timers.keys()]) clearTimers(id);
      await Promise.all([...running]);
    },
  };
}
