// The question pipeline (design.md "Question pipeline"): the answerer drafts; the assessor gives its
// own best answer and decides whether the owner must see it, and fails closed; the risk rules run
// after it on the answer to be typed; accepted → that answer is typed into the job, otherwise the
// human stage. The answerer and assessor are looked up per question (live roles), and every result
// is validated here: a plugin that breaks its contract escalates, it never answers.
import type { AnswerByHumanResult, AnswerDraft, AnswerRequest, Answerer, Assessor, Clock, ConfigDocuments, QuestionService, Store } from '../domain/ports.ts';
import type { AttemptRole, Question, QuestionAttempt } from '../domain/types.ts';
import { ASSESSMENT, DRAFT, check } from './results.ts';
import { riskRules } from './risk.ts';
import { readRules } from './rules.ts';

export interface QuestionServiceOptions {
  store: Store;
  clock: Clock;
  /** The answerer role's current instance, or undefined (none configured, or it cannot run). Called per question. */
  answerer(): Answerer | undefined;
  /** The assessor role's current instance (`always-escalate` stands in when the configured one cannot run). Called per question. */
  assessor(): Assessor;
  /** Ceiling on one answerer or assessor call. Past it the call is aborted and counts as an error. */
  stageTimeoutMs: number;
  /** Where rules.md is read, on every ask. */
  documents: ConfigDocuments;
  renotifyMs: number;
  humanTimeoutMs: number;
  answerUrl: (questionId: string) => string;
  /** Synchronous, called inside the tx that marks the question answered or closed. */
  onAnswered: (q: Question) => void;
  /** Synchronous, called inside the tx that marks the question expired. */
  onExpired: (q: Question) => void;
  /** Synchronous, called inside the tx that marks the question dismissed. */
  onDismissed: (q: Question) => void;
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

  function emit(q: Question, type: 'question.escalated' | 'question.answered' | 'question.closed' | 'question.dismissed' | 'question.expired', data: Record<string, unknown>) {
    store.events.append({ type, jobId: q.jobId, questionId: q.id, data: { questionId: q.id, ...data } });
  }

  function clearTimers(id: string) {
    const t = timers.get(id);
    if (t) { clearTimeout(t.renotify); clearTimeout(t.expiry); }
    timers.delete(id);
  }

  function abortStage(id: string, reason: string) {
    inflight.get(id)?.abort(reason);
    inflight.delete(id);
  }

  function escalationData(q: Question, target: string, reason: string): Record<string, unknown> {
    const base = { target, reason, text: q.text, jobId: q.jobId };
    if (target !== HUMAN) return base;
    return { ...base, goal: store.jobs.get(q.jobId)?.spec.goal, answerUrl: o.answerUrl(q.id), notifyCount: q.notifyCount };
  }

  // ---- the human stage ------------------------------------------------------------------

  function expire(id: string) {
    store.tx(() => {
      const q = store.questions.get(id);
      if (!q || q.status !== 'open' || q.tier !== HUMAN) return;
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
      if (!q || q.status !== 'open' || q.tier !== HUMAN) return;
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
    if (!q || q.status !== 'open' || q.tier !== HUMAN || !q.expiresAt) return;
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
    emit(updated, 'question.escalated', escalationData(updated, HUMAN, reason));
    queueMicrotask(() => armHuman(q.id));
  }

  // ---- the answer and assess stages -----------------------------------------------------

  /** Inside a tx. The question as it is now, if it is still open at `stage`. */
  function stillAt(id: string, stage: string): Question | undefined {
    const q = store.questions.get(id);
    return q && q.status === 'open' && q.tier === stage ? q : undefined;
  }

  /** Inside a tx. A stage result that lost the race (human answer, cancel, restart) is logged and ignored. */
  function superseded(id: string, who: { name: string; model?: string }, role: AttemptRole, startedAt: string) {
    if (!store.questions.get(id)) return;
    store.questions.addAttempt(id, {
      tier: who.name, role, ...(who.model ? { model: who.model } : {}), startedAt, finishedAt: iso(), outcome: 'escalated', reason: 'superseded',
    });
  }

  /** Inside a tx. Moves an open question to `stage` and announces it. */
  function enter(q: Question, stage: string, reason: string): Question {
    const updated = q.tier === stage ? q : store.questions.update(q.id, { tier: stage });
    emit(updated, 'question.escalated', escalationData(updated, stage, reason));
    return updated;
  }

  /** One stage call: aborted by cancel, a human answer, shutdown, or the stage timeout; a throw is an error. */
  async function call<T>(id: string, fn: (signal: AbortSignal) => Promise<T>): Promise<{ result: T | { error: string }; ac: AbortController }> {
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
      const result = await Promise.race([fn(ac.signal).catch((e: unknown) => ({ error: `threw: ${e instanceof Error ? e.message : String(e)}` })), timeout]);
      return { result, ac };
    } finally {
      clearTimeout(timer);
      if (inflight.get(id) === ac) inflight.delete(id);
    }
  }

  function requestFor(q: Question): { req: AnswerRequest; rulesNote: string } {
    const rules = readRules(o.documents);
    const job = store.jobs.get(q.jobId);
    return {
      req: {
        question: q,
        jobPrompt: typeof job?.spec.payload.prompt === 'string' ? job.spec.payload.prompt : '',
        jobGoal: job?.spec.goal,
        rules: rules.text,
        previous: q.attempts,
      },
      rulesNote: rules.missing ? ' (no rules.md yet)' : '',
    };
  }

  async function run(id: string, reason: string): Promise<void> {
    if (stopped) return;
    const answerer = o.answerer();
    const entered = store.tx((): Question | undefined => {
      const q = store.questions.get(id);
      if (!q || q.status !== 'open') return undefined;
      if (!answerer) {
        toHuman(q, 'no answerer configured');
        return undefined;
      }
      return enter(q, answerer.name, reason);
    });
    if (!entered || !answerer) return;
    const { req, rulesNote } = requestFor(entered);

    // 1. The answerer drafts.
    const answeredAt = iso();
    const drafted = await call(id, (signal) => answerer.answer(req, signal));
    if (stopped) return;
    const draft = check<AnswerDraft>(DRAFT, 'draft', drafted.result);
    const assessor = store.tx((): Assessor | undefined => {
      const q = stillAt(id, answerer.name);
      if (!q) return void superseded(id, answerer, 'answerer', answeredAt);
      const model = (draft.ok ? draft.value.model : undefined) ?? answerer.model;
      const base: QuestionAttempt = {
        tier: answerer.name, role: 'answerer', ...(model ? { model } : {}),
        startedAt: answeredAt, finishedAt: iso(), outcome: 'escalated',
      };
      if (!draft.ok) {
        store.questions.addAttempt(id, { ...base, error: draft.error, reason: `error${rulesNote}` });
        return void toHuman(q, `answerer ${answerer.name} failed: ${draft.error}`);
      }
      // Every draft goes to the assessor, confident or not (owner decision, 2026-10-04: Opus, then
      // Fable, then the owner on every question); the assessor sees the answerer's confidence and
      // gives its own best answer (issue #98).
      const { answer, confident, reason: why } = draft.value;
      store.questions.addAttempt(id, { ...base, answer, confident, reason: `${why}${rulesNote}`, outcome: 'drafted' });
      const next = o.assessor();
      enter(q, next.name, `drafted by ${answerer.name}`);
      return next;
    });
    if (!assessor || !draft.ok) return;

    // 2. The assessor answers and decides whether the owner must see it; 3. the risk rules run after
    // it on the answer to be typed: the assessor's own, or the draft it endorsed.
    const assessedAt = iso();
    const assessed = await call(id, (signal) => assessor.assess(req, draft.value, signal));
    if (stopped) return;
    const verdict = check(ASSESSMENT, 'assessment', assessed.result);
    store.tx(() => {
      const q = stillAt(id, assessor.name);
      if (!q) return superseded(id, assessor, 'assessor', assessedAt);
      const own = verdict.ok ? verdict.value.answer : undefined;
      const typed = own ?? draft.value.answer;
      const by = own === undefined ? answerer.name : assessor.name;
      const hits = riskRules(`${q.text}\n${typed}`);
      const model = (verdict.ok ? verdict.value.model : undefined) ?? assessor.model;
      const base: QuestionAttempt = {
        tier: assessor.name, role: 'assessor', ...(model ? { model } : {}),
        startedAt: assessedAt, finishedAt: iso(), riskRules: hits, outcome: 'escalated',
        ...(own === undefined ? {} : { answer: own }),
      };
      if (!verdict.ok) {
        store.questions.addAttempt(id, { ...base, error: verdict.error });
        return toHuman(q, `assessor ${assessor.name} failed: ${verdict.error}`);
      }
      const { escalate, reason: why } = verdict.value;
      if (escalate !== false) {
        store.questions.addAttempt(id, { ...base, escalate, reason: why });
        return toHuman(q, `assessor ${assessor.name}: ${why}`);
      }
      if (hits.length > 0) {
        store.questions.addAttempt(id, { ...base, escalate, reason: why });
        return toHuman(q, `risk rules: ${hits.join(', ')}`);
      }
      // 4. Accepted: the assessor's own answer, or the draft it endorsed, is typed into the job.
      store.questions.addAttempt(id, { ...base, escalate, reason: why, outcome: 'accepted' });
      const updated = store.questions.update(id, { status: 'answered', answer: typed, answeredBy: by });
      emit(updated, 'question.answered', { by, answer: typed });
      o.onAnswered(updated);
    });
  }

  function start(id: string, reason: string) {
    const p: Promise<void> = run(id, reason)
      .catch((err: unknown) => console.error(`question ${id}: pipeline failed`, err))
      .finally(() => running.delete(p));
    running.add(p);
  }

  /** The owner settles an open question: their answer, or the close text. Wins over any stage in flight. */
  /** Inside a tx. Ends an open question as the owner's; the caller decides what the job does. */
  function settle(q: Question, answer: string, status: 'answered' | 'closed', via?: 'pane'): Question {
    abortStage(q.id, 'superseded');
    clearTimers(q.id);
    const at = iso();
    store.questions.addAttempt(q.id, {
      tier: HUMAN, role: 'human', startedAt: at, finishedAt: at, answer, outcome: 'accepted',
      ...(status === 'closed' ? { reason: 'closed without answering' } : via ? { reason: 'answered in the pane' } : {}),
    });
    const updated = store.questions.update(q.id, { status, answer, answeredBy: HUMAN });
    if (status === 'closed') emit(updated, 'question.closed', { answer });
    else emit(updated, 'question.answered', { by: HUMAN, answer, ...(via ? { via } : {}) });
    return updated;
  }

  function byHuman(id: string, answer: string, status: 'answered' | 'closed'): AnswerByHumanResult {
    return store.tx(() => {
      const q = store.questions.get(id);
      if (!q) return { ok: false as const, reason: 'not_found' as const };
      if (q.status !== 'open') return { ok: false as const, reason: 'not_open' as const };
      const updated = settle(q, answer, status);
      o.onAnswered(updated);
      return { ok: true as const, question: updated };
    });
  }

  return {
    firstStage: () => o.answerer()?.name ?? HUMAN,

    handle(id) {
      start(id, 'asked');
    },

    answerByHuman: (id, answer) => byHuman(id, answer, 'answered'),
    closeByHuman: (id) => byHuman(id, CLOSED_ANSWER, 'closed'),

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

    cancel(id) {
      store.tx(() => {
        const q = store.questions.get(id);
        if (!q || q.status !== 'open') return;
        abortStage(id, 'cancel');
        clearTimers(id);
        store.questions.update(id, { status: 'cancelled' });
      });
    },

    recover() {
      for (const q of store.questions.list({ status: ['open'] })) {
        if (q.tier !== HUMAN) start(q.id, 'restarted after a daemon restart');
        else if (q.expiresAt) armHuman(q.id);
        // Created at the human stage (no answerer), the daemon stopped before it was announced.
        else store.tx(() => toHuman(q, 'no answerer configured'));
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
