import type {
  AnswerVerdict, Answerer, Clock, QuestionService, Store,
} from '../domain/ports.ts';
import type { AnswerTier, Question, QuestionAttempt } from '../domain/types.ts';
import { riskRules } from './risk.ts';
import { readRulesFile } from './rules-file.ts';

export interface QuestionServiceOptions {
  store: Store;
  clock: Clock;
  answerers: Answerer[];
  rulesFile: string;
  renotifyMs: number;
  humanTimeoutMs: number;
  answerUrl: (questionId: string) => string;
  /** Synchronous, called inside the tx that marks the question answered. */
  onAnswered: (q: Question) => void;
  /** Synchronous, called inside the tx that marks the question expired. */
  onExpired: (q: Question) => void;
}

type ModelTier = Exclude<AnswerTier, 'human'>;
const NEXT: Record<ModelTier, AnswerTier> = { opus: 'fable', fable: 'human' };

interface Timers { renotify?: NodeJS.Timeout; expiry?: NodeJS.Timeout }

export function createQuestionService(o: QuestionServiceOptions): QuestionService {
  const { store, clock } = o;
  const inflight = new Map<string, AbortController>();
  const timers = new Map<string, Timers>();
  const running = new Set<Promise<void>>();
  let stopped = false;
  const iso = () => clock.now().toISOString();

  function emit(q: Question, type: 'question.escalated' | 'question.answered' | 'question.expired', data: Record<string, unknown>) {
    store.events.append({ type, jobId: q.jobId, questionId: q.id, data: { questionId: q.id, ...data } });
  }

  function clearTimers(id: string) {
    const t = timers.get(id);
    if (t) { clearTimeout(t.renotify); clearTimeout(t.expiry); }
    timers.delete(id);
  }

  function abortTier(id: string, reason: string) {
    inflight.get(id)?.abort(reason);
    inflight.delete(id);
  }

  function escalationData(q: Question, target: AnswerTier, reason: string): Record<string, unknown> {
    const goal = store.jobs.get(q.jobId)?.spec.goal;
    const base = { target, reason, text: q.text, jobId: q.jobId };
    if (target !== 'human') return base;
    return { ...base, goal, answerUrl: o.answerUrl(q.id), notifyCount: q.notifyCount };
  }

  // ---- human tier ---------------------------------------------------------------------

  function expire(id: string) {
    store.tx(() => {
      const q = store.questions.get(id);
      if (!q || q.status !== 'open' || q.tier !== 'human') return;
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
      if (!q || q.status !== 'open' || q.tier !== 'human') return;
      const updated = store.questions.update(id, { notifyCount: q.notifyCount + 1, lastNotifiedAt: iso() });
      emit(updated, 'question.escalated', { ...escalationData(updated, 'human', 'still unanswered'), renotify: true });
    });
    armHuman(id);
  }

  /** (Re)arm renotify and expiry from the stored times. Expiry wins a tie. */
  function armHuman(id: string) {
    clearTimers(id);
    const q = store.questions.get(id);
    if (!q || q.status !== 'open' || q.tier !== 'human' || !q.expiresAt) return;
    const now = clock.now().getTime();
    const expiresIn = new Date(q.expiresAt).getTime() - now;
    if (expiresIn <= 0) return expire(id);
    const t: Timers = { expiry: setTimeout(() => expire(id), expiresIn) };
    const renotifyIn = Math.max(0, new Date(q.lastNotifiedAt ?? q.createdAt).getTime() + o.renotifyMs - now);
    if (renotifyIn < expiresIn) t.renotify = setTimeout(() => renotify(id), renotifyIn);
    timers.set(id, t);
  }

  // ---- model tiers ---------------------------------------------------------------------

  function logSuperseded(id: string, tier: ModelTier, model: string, startedAt: string) {
    store.tx(() => {
      if (!store.questions.get(id)) return;
      store.questions.addAttempt(id, {
        tier, model, startedAt, finishedAt: iso(), outcome: 'escalated', reason: 'superseded',
      });
    });
  }

  function escalationReason(v: AnswerVerdict, rules: string[]): string | undefined {
    const why: string[] = [];
    if (!v.confident) why.push('not confident');
    if (v.risky) why.push('model marked risky');
    if (rules.length > 0) why.push(`risk rules: ${rules.join(', ')}`);
    return why.length > 0 ? why.join('; ') : undefined;
  }

  function settle(id: string, tier: ModelTier, answerer: Answerer, startedAt: string, rulesNote: string,
    result: AnswerVerdict | { error: string }) {
    store.tx(() => {
      const q = store.questions.get(id);
      if (!q || q.status !== 'open' || q.tier !== tier) return logSuperseded(id, tier, answerer.model, startedAt);
      const base = { tier, model: answerer.model, startedAt, finishedAt: iso() };
      if ('error' in result) {
        return escalate(q, { ...base, error: result.error, reason: `error${rulesNote}`, outcome: 'escalated' }, `error: ${result.error}`);
      }
      const hits = riskRules(`${q.text}\n${result.answer}`);
      const why = escalationReason(result, hits);
      const attempt: QuestionAttempt = {
        ...base, answer: result.answer, confident: result.confident, risky: result.risky,
        riskRules: hits, reason: `${result.reason}${rulesNote}`, outcome: why ? 'escalated' : 'accepted',
      };
      if (why) return escalate(q, attempt, why);
      store.questions.addAttempt(id, attempt);
      const updated = store.questions.update(id, { status: 'answered', answer: result.answer, answeredBy: tier });
      emit(updated, 'question.answered', { by: tier, answer: result.answer });
      o.onAnswered(updated);
    });
  }

  /** Inside a tx. Appends the attempt, moves the question up a tier, announces it. */
  function escalate(q: Question, attempt: QuestionAttempt, reason: string) {
    store.questions.addAttempt(q.id, attempt);
    const target = NEXT[attempt.tier as ModelTier];
    if (target === 'human') {
      const now = clock.now();
      const updated = store.questions.update(q.id, {
        tier: 'human', escalatedToHumanAt: now.toISOString(), lastNotifiedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + o.humanTimeoutMs).toISOString(), notifyCount: 1,
      });
      emit(updated, 'question.escalated', escalationData(updated, 'human', reason));
      queueMicrotask(() => armHuman(q.id));
      return;
    }
    const updated = store.questions.update(q.id, { tier: target });
    emit(updated, 'question.escalated', escalationData(updated, target, reason));
    start(q.id, target, false);
  }

  async function runTier(id: string, tier: ModelTier, announce: boolean): Promise<void> {
    if (stopped) return;
    const answerer = o.answerers.find((a) => a.tier === tier);
    const q = store.questions.get(id);
    if (!q || q.status !== 'open' || q.tier !== tier) return;
    if (!answerer) {
      store.tx(() => escalate(q, { tier, startedAt: iso(), finishedAt: iso(), error: `no ${tier} answerer`, outcome: 'escalated' }, `no ${tier} answerer`));
      return;
    }
    if (announce) store.tx(() => emit(q, 'question.escalated', escalationData(q, tier, 'asked')));
    const rules = readRulesFile(o.rulesFile);
    const job = store.jobs.get(q.jobId);
    const ac = new AbortController();
    inflight.set(id, ac);
    const startedAt = iso();
    const result = await answerer.answer({
      question: q,
      jobPrompt: typeof job?.spec.payload.prompt === 'string' ? job.spec.payload.prompt : '',
      jobGoal: job?.spec.goal,
      rules: rules.text,
      previous: q.attempts,
    }, ac.signal);
    if (inflight.get(id) === ac) inflight.delete(id);
    if (stopped) return;
    settle(id, tier, answerer, startedAt, rules.missing ? ' (rules file missing)' : '', result);
  }

  function start(id: string, tier: ModelTier, announce: boolean) {
    const p: Promise<void> = runTier(id, tier, announce)
      .catch((err: unknown) => console.error(`question ${id}: ${tier} tier failed`, err))
      .finally(() => running.delete(p));
    running.add(p);
  }

  return {
    handle(id) {
      start(id, 'opus', true);
    },

    answerByHuman(id, answer) {
      return store.tx(() => {
        const q = store.questions.get(id);
        if (!q) return { ok: false as const, reason: 'not_found' as const };
        if (q.status !== 'open') return { ok: false as const, reason: 'not_open' as const };
        abortTier(id, 'superseded');
        clearTimers(id);
        const at = iso();
        store.questions.addAttempt(id, { tier: 'human', startedAt: at, finishedAt: at, answer, outcome: 'accepted' });
        const updated = store.questions.update(id, { status: 'answered', answer, answeredBy: 'human' });
        emit(updated, 'question.answered', { by: 'human', answer });
        o.onAnswered(updated);
        return { ok: true as const, question: updated };
      });
    },

    cancel(id) {
      store.tx(() => {
        const q = store.questions.get(id);
        if (!q || q.status !== 'open') return;
        abortTier(id, 'cancel');
        clearTimers(id);
        store.questions.update(id, { status: 'cancelled' });
      });
    },

    recover() {
      for (const q of store.questions.list({ status: ['open'] })) {
        if (q.tier === 'human') armHuman(q.id);
        else start(q.id, q.tier, q.tier === 'opus');
      }
    },

    async stop() {
      stopped = true;
      for (const id of [...inflight.keys()]) abortTier(id, 'shutdown');
      for (const id of [...timers.keys()]) clearTimers(id);
      await Promise.all([...running]);
    },
  };
}
