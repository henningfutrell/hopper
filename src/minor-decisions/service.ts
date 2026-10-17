// Jev first (issue #550, design.md "Decider calls"): asked before anything else at every decision point. A point hands it a
// decider call — its options, the facts, and what makes it consequential —; per the point's settings (in the
// database, read on every decision) Jev is not asked (off), asked and only recorded (shadow), or asked and its pick
// applied when it meets the point's threshold and nothing makes it consequential (active). Every pick is an event on
// its job. What is decided after a pick that was not applied is compared with it — a question's answer, a
// person's action on a hand-off, the machine a job got, an admin's act on a lane recommendation —, and a person may override any pick: the agreement rates a person flips a point to
// active on. Without Jev (no TypeSafe API key, issue #657) nothing is asked and nothing recorded: each decision is made as before.
// The risk call on a level's answer (issue #679) is a typed decision of its own, in ./risk.ts; the Decider answers no question.
import { randomUUID } from 'node:crypto';
import type { Clock, EventFollower, UserStore } from '../domain/ports.ts';
import {
  DECISION_POINTS, DEFAULT_MINOR_DECISION_SETTINGS, MINOR_DECISION_WINDOW_DAYS, type DecisionPoint, type DecisionPointPatch, type DecisionPointSettings,
  type DomainEvent, type JevChooser, type JevPick, type MinorDecisionInput, type MinorDecisionOutcome, type MinorDecisionPickView,
  type MinorDecisionSettings, type JevFirst, type MinorDecisionsView, type NotApplied, type QuestionRisk, type TypesafeKeyView,
} from '../domain/types.ts';
import { withDeadline } from './deadline.ts';
import { askRisk } from './risk.ts';
import { picksOf, viewOf, VIEW_EVENT_TYPES } from './view.ts';

export interface MinorDecisionsOptions {
  store: UserStore;
  clock: Clock;
  jev: JevChooser;
  /** The TypeSafe API key as the Jev page shows it (issue #657); never the key. */
  typesafeKey: () => TypesafeKeyView;
  /** Ceiling on one pick; past it, no pick. */
  timeoutMs: number;
  logger: { warn(line: string): void };
}

export type OverrideResult = { ok: true; value: MinorDecisionPickView } | { ok: false; reason: 'not_found' | 'invalid'; message: string };

export interface MinorDecisions extends JevFirst, QuestionRisk {
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
/** What a person's end of a hand-off says the failed job needed. */
const HANDOFF_ACTUAL: Readonly<Record<string, string>> = {
  run_again: 'retry', continued: 'retry', cleared: 'person', done_by_hand: 'person', wont_do: 'person',
};

/** The events what is decided after a pick is read from. */
const FOLLOWED: ReadonlySet<string> = new Set(['handoff.closed', 'job.claimed', 'lanes.applied', 'lanes.dismissed']);

export function createMinorDecisions(o: MinorDecisionsOptions): MinorDecisions {
  const { store, clock } = o;
  let follower: EventFollower | undefined;
  /** The followed events handed and not compared yet, by seq: the cursor stays before the oldest (issue #1572). */
  const due = new Set<number>();
  let stopped = false;

  const settings = (): MinorDecisionSettings => {
    const saved = store.settings.getMinorDecisionSettings();
    return Object.fromEntries(DECISION_POINTS.map((p) => [p, { ...DEFAULT_MINOR_DECISION_SETTINGS[p], ...saved[p] }])) as MinorDecisionSettings;
  };
  const windowEvents = (): DomainEvent[] =>
    store.events.between(VIEW_EVENT_TYPES, new Date(clock.now().getTime() - MINOR_DECISION_WINDOW_DAYS * DAY_MS).toISOString());
  const picks = () => picksOf(windowEvents());

  function ask(input: MinorDecisionInput): Promise<JevPick> {
    const { point, instructions, options, state } = input;
    return withDeadline(o.timeoutMs, (signal) => o.jev.pick({ point, instructions, options, state }, signal), { ok: false, why: `no pick within ${o.timeoutMs} ms` });
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
    if (stopped) return { asked: false };
    // Decided while Jev was asked (a job placed before its pick came): not applied, and compared at once.
    const settled = input.settled?.() ?? (input.rules !== undefined && notAppliedOf(s, pick, input.consequential) ? { actual: input.rules, by: 'rules' } : undefined);
    const notApplied = notAppliedOf(s, pick, input.consequential) ?? (settled ? 'too_late' : undefined);
    const pickId = randomUUID();
    const tags = { ...(input.jobId ? { jobId: input.jobId } : {}), ...(input.questionId ? { questionId: input.questionId } : {}) };
    store.tx(() => {
      store.events.append({
        type: 'minor_decision.picked', ...tags,
        data: {
          pickId, point: input.point, by: 'jev', options: input.options.map((x) => ({ id: x.id, label: x.label })),
          ...(pick.ok ? { pick: pick.pick, confidence: pick.confidence } : { error: pick.why }),
          mode: s.mode, threshold: s.threshold, applied: notApplied === undefined,
          ...(notApplied ? { notApplied } : {}), ...(notApplied === 'consequential' ? { consequential: [...input.consequential] } : {}),
          ...(input.questionId ? { questionId: input.questionId } : {}), ...(input.machineId ? { machineId: input.machineId } : {}),
        },
      });
      if (settled && pick.ok) {
        store.events.append({
          type: 'minor_decision.compared', ...tags,
          data: { pickId, point: input.point, pick: pick.pick, actual: settled.actual, agreed: settled.actual === pick.pick, decidedBy: settled.by },
        });
      }
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
    if (e.type === 'handoff.closed' && e.jobId && typeof d.end === 'string' && HANDOFF_ACTUAL[d.end]) {
      const actual = HANDOFF_ACTUAL[d.end];
      compare((p) => p.point === 'failure-assessment' && p.jobId === e.jobId, () => actual, 'person');
    } else if (e.type === 'job.claimed' && e.jobId && e.machineId) {
      const machineId = e.machineId;
      compare((p) => p.point === 'job-machine' && p.jobId === e.jobId, () => machineId, 'placement');
    } else if ((e.type === 'lanes.applied' || e.type === 'lanes.dismissed') && typeof d.by === 'string') {
      // An admin's act on a machine's lane recommendation: the lanes applied, or the configured lanes kept.
      const actual = String(e.type === 'lanes.applied' ? d.to : d.configured);
      compare((p) => p.point === 'lane-count' && p.machineId === d.machineId, () => actual, d.by);
    }
  }

  return {
    decide: (input) => decide(input).catch((e: unknown) => {
      o.logger.warn(`hopper: a decider call at ${input.point} failed: ${e instanceof Error ? e.message : String(e)}`);
      return { asked: false };
    }),
    // Fail closed (issue #679): a risk call that breaks is an error, which an active point holds the question for.
    risk: (input) => askRisk({ store, jev: o.jev, settings: () => settings()['question-risk'], timeoutMs: o.timeoutMs, stopped: () => stopped }, input).catch((e: unknown) => {
      const why = e instanceof Error ? e.message : String(e);
      o.logger.warn(`hopper: the risk call failed: ${why}`);
      const s = settings()['question-risk'];
      return s.mode === 'off' ? { asked: false as const, why } : { asked: true as const, mode: s.mode, threshold: s.threshold, error: why };
    }),
    // From the comparisons' event cursor (issue #1572): what was decided while they were stopped is compared at the next
    // start, each comparison kept with the cursor in one transaction.
    start() {
      follower ??= store.eventCursors.follow('minor-decisions', (e) => {
        if (stopped || !FOLLOWED.has(e.type)) return;
        due.add(e.seq);
        setImmediate(() => {
          if (stopped) return;
          due.delete(e.seq);
          try {
            store.tx(() => { follow(e); follower?.save(due.size > 0 ? Math.min(...due) - 1 : undefined); });
          } catch (err) { o.logger.warn(`hopper: comparing a decider call failed: ${err instanceof Error ? err.message : String(err)}`); }
        });
      });
    },
    stop() {
      stopped = true;
      follower?.stop();
      // The events not followed since the last comparison are passed; a comparison not made yet is made at the next start.
      try { follower?.save(due.size > 0 ? Math.min(...due) - 1 : undefined); } catch (err) { o.logger.warn(`hopper: keeping the comparisons' event cursor failed: ${err instanceof Error ? err.message : String(err)}`); }
    },
    view: () => viewOf(windowEvents(), settings(), o.jev.available(), o.typesafeKey()),
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
