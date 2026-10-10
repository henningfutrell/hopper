// Jev first (issue #550, design.md "Decider calls"): asked before anything else at every decision point. A point hands it a
// decider call — its options, the facts, and what makes it consequential —; per the point's settings (in the
// database, read on every decision) Jev is not asked (off), asked and only recorded (shadow), or asked and its pick
// applied when it meets the point's threshold and nothing makes it consequential (active). Every pick is an event on
// its job. What is decided after a pick that was not applied is compared with it — a question's answer, a
// person's action on a hand-off —, and a person may override any pick: the agreement rates a person flips a point to
// active on. Without Jev (no TypeSafe key) nothing is asked and nothing recorded: each decision is made as before.
import { randomUUID } from 'node:crypto';
import type { Clock, UserStore } from '../domain/ports.ts';
import {
  DECISION_POINTS, DEFAULT_MINOR_DECISION_SETTINGS, MINOR_DECISION_WINDOW_DAYS, type DecisionPoint, type DecisionPointPatch, type DecisionPointSettings,
  type DomainEvent, type JevChooser, type JevPick, type MinorDecisionInput, type MinorDecisionOutcome, type MinorDecisionPickView,
  type MinorDecisionSettings, type JevFirst, type MinorDecisionsView, type NotApplied,
} from '../domain/types.ts';
import { optionNamed } from './options.ts';
import { picksOf, viewOf, VIEW_EVENT_TYPES } from './view.ts';

export interface MinorDecisionsOptions {
  store: UserStore;
  clock: Clock;
  jev: JevChooser;
  /** Ceiling on one pick; past it, no pick. */
  timeoutMs: number;
  logger: { warn(line: string): void };
}

export type OverrideResult = { ok: true; value: MinorDecisionPickView } | { ok: false; reason: 'not_found' | 'invalid'; message: string };

export interface MinorDecisions extends JevFirst {
  /** Follow what is decided after a pick. Once. */
  start(): void;
  stop(): void;
  view(): MinorDecisionsView;
  settings(): MinorDecisionSettings;
  /** An admin changes one point's settings; applies from the next decision. */
  setPoint(point: DecisionPoint, patch: DecisionPointPatch): DecisionPointSettings;
  /** A person says what a pick should have been: one of its options. */
  override(pickId: string, actual: string): OverrideResult;
}

const DAY_MS = 86_400_000;
/** A free-text answer, kept as what was decided, at most this long. */
const ACTUAL_MAX = 200;
/** What a person's end of a hand-off says the failed job needed. */
const HANDOFF_ACTUAL: Readonly<Record<string, string>> = {
  run_again: 'retry', continued: 'retry', cleared: 'person', done_by_hand: 'person', wont_do: 'person',
};

export function createMinorDecisions(o: MinorDecisionsOptions): MinorDecisions {
  const { store, clock } = o;
  let unsubscribe: (() => void) | undefined;
  let stopped = false;

  const settings = (): MinorDecisionSettings => {
    const saved = store.settings.getMinorDecisionSettings();
    return Object.fromEntries(DECISION_POINTS.map((p) => [p, { ...DEFAULT_MINOR_DECISION_SETTINGS[p], ...saved[p] }])) as MinorDecisionSettings;
  };
  const windowEvents = (): DomainEvent[] =>
    store.events.between(VIEW_EVENT_TYPES, new Date(clock.now().getTime() - MINOR_DECISION_WINDOW_DAYS * DAY_MS).toISOString());
  const picks = () => picksOf(windowEvents());

  async function ask(input: MinorDecisionInput): Promise<JevPick> {
    let timer: NodeJS.Timeout | undefined;
    const ac = new AbortController();
    const timeout = new Promise<JevPick>((resolve) => {
      timer = setTimeout(() => { ac.abort(); resolve({ ok: false, why: `no pick within ${o.timeoutMs} ms` }); }, o.timeoutMs);
    });
    try {
      const { point, instructions, options, state } = input;
      return await Promise.race([o.jev.pick({ point, instructions, options, state }, ac.signal).catch((e: unknown) => ({ ok: false as const, why: e instanceof Error ? e.message : String(e) })), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  function notAppliedOf(s: DecisionPointSettings, pick: JevPick, consequential: readonly string[]): NotApplied | undefined {
    if (!pick.ok) return 'no_pick';
    if (consequential.length > 0) return 'consequential';
    if (s.mode === 'shadow') return 'shadow';
    if (pick.confidence < s.threshold) return 'below_threshold';
    return undefined;
  }

  async function decide(input: MinorDecisionInput): Promise<MinorDecisionOutcome> {
    const s = settings()[input.point];
    if (s.mode === 'off' || stopped || !o.jev.available().available) return { asked: false };
    const pick = await ask(input);
    const notApplied = notAppliedOf(s, pick, input.consequential);
    const pickId = randomUUID();
    store.events.append({
      type: 'minor_decision.picked', ...(input.jobId ? { jobId: input.jobId } : {}), ...(input.questionId ? { questionId: input.questionId } : {}),
      data: {
        pickId, point: input.point, by: 'jev', options: input.options.map((x) => ({ id: x.id, label: x.label })),
        ...(pick.ok ? { pick: pick.pick, confidence: pick.confidence } : { error: pick.why }),
        mode: s.mode, threshold: s.threshold, applied: notApplied === undefined,
        ...(notApplied ? { notApplied } : {}), ...(notApplied === 'consequential' ? { consequential: [...input.consequential] } : {}),
        ...(input.questionId ? { questionId: input.questionId } : {}),
      },
    });
    return {
      asked: true, pickId, applied: notApplied === undefined,
      ...(pick.ok ? { pick: pick.pick, confidence: pick.confidence } : {}), ...(notApplied ? { notApplied } : {}),
    };
  }

  /** What was decided after a pick, compared with the open pick it follows: one not applied, not compared yet. */
  function compare(find: (p: MinorDecisionPickView) => boolean, actualOf: (p: MinorDecisionPickView) => string | undefined, decidedBy: string): void {
    const p = picks().filter((x) => !x.applied && x.pick !== undefined && x.actual === undefined && find(x)).at(-1);
    if (!p) return;
    const actual = actualOf(p);
    if (actual === undefined) return;
    store.events.append({
      type: 'minor_decision.compared', ...(p.jobId ? { jobId: p.jobId } : {}), ...(p.questionId ? { questionId: p.questionId } : {}),
      data: { pickId: p.pickId, point: p.point, pick: p.pick!, actual, agreed: actual === p.pick, decidedBy },
    });
  }

  function follow(e: DomainEvent): void {
    const d = e.data as Record<string, unknown>;
    if (e.type === 'question.answered' && d.by !== 'jev' && typeof d.answer === 'string' && e.questionId) {
      const answer = d.answer;
      compare((p) => p.point === 'question-answer' && p.questionId === e.questionId, (p) => optionNamed(p.options, answer) ?? answer.slice(0, ACTUAL_MAX), String(d.by));
    } else if (e.type === 'handoff.closed' && e.jobId && typeof d.end === 'string' && HANDOFF_ACTUAL[d.end]) {
      const actual = HANDOFF_ACTUAL[d.end];
      compare((p) => p.point === 'failure-assessment' && p.jobId === e.jobId, () => actual, 'person');
    }
  }

  return {
    decide: (input) => decide(input).catch((e: unknown) => {
      o.logger.warn(`hopper: a decider call at ${input.point} failed: ${e instanceof Error ? e.message : String(e)}`);
      return { asked: false };
    }),
    start() {
      unsubscribe ??= store.events.subscribe((e) => {
        if (stopped || (e.type !== 'question.answered' && e.type !== 'handoff.closed')) return;
        setImmediate(() => {
          if (stopped) return;
          try { follow(e); } catch (err) { o.logger.warn(`hopper: comparing a decider call failed: ${err instanceof Error ? err.message : String(err)}`); }
        });
      });
    },
    stop() { stopped = true; unsubscribe?.(); },
    view: () => viewOf(windowEvents(), settings(), o.jev.available()),
    settings,
    setPoint(point, patch) {
      const all = settings();
      const from = all[point];
      const to: DecisionPointSettings = { mode: patch.mode ?? from.mode, threshold: patch.threshold ?? from.threshold };
      store.tx(() => {
        store.settings.setMinorDecisionSettings({ ...all, [point]: to });
        if (from.mode !== to.mode || from.threshold !== to.threshold) store.events.append({ type: 'minor_decision.settings_changed', data: { point, from, to } });
      });
      return to;
    },
    override(pickId, actual) {
      const p = picks().find((x) => x.pickId === pickId);
      if (!p) return { ok: false, reason: 'not_found', message: `pick ${pickId} not found` };
      if (!p.options.some((x) => x.id === actual)) return { ok: false, reason: 'invalid', message: `${actual} is not one of its options: ${p.options.map((x) => x.id).join(', ')}` };
      store.events.append({
        type: 'minor_decision.overridden', ...(p.jobId ? { jobId: p.jobId } : {}), ...(p.questionId ? { questionId: p.questionId } : {}),
        data: { pickId, point: p.point, ...(p.pick !== undefined ? { pick: p.pick } : {}), actual },
      });
      return { ok: true, value: { ...p, actual, decidedBy: 'override', agreed: actual === p.pick, overridden: true } };
    },
  };
}
