// Grades in the UI (issue #2845), pure: the words of a grade on the job view — its signals, the user grade and its history —,
// the groups of the Grades tab, the summary of the grade settings in Settings, and the change a save sends.
import type { Tone } from './jobs-view.ts';
import type { GradeGroup, GradeLine, GradeSettings, GradeSignal, UserGrade } from './wire.ts';

export const SIGNALS: readonly GradeSignal[] = ['outcome', 'checks', 'pull_request', 'rework', 'cost', 'time', 'review'];
export const SIGNAL_NAMES: Record<GradeSignal, string> = { outcome: 'Outcome', checks: 'Checks', pull_request: 'Pull request', rework: 'Rework', cost: 'Cost', time: 'Time', review: 'Completion review' };

export const GROUPS: readonly GradeGroup[] = ['executor', 'model', 'repo', 'kind', 'machine'];
export const GROUP_NAMES: Record<GradeGroup, string> = { executor: 'Executor', model: 'Model', repo: 'Repository', kind: 'Work kind', machine: 'Machine' };

/** One signal of the breakdown in one line: what, why, its value on the score's scale and its weight. */
export const gradeLineText = (l: GradeLine): string => `${SIGNAL_NAMES[l.signal]}: ${l.why} (${Math.round(l.value * 100)} of 100, weight ${l.weight})`;

/** The colour of an automatic grade: good from 70, middling from 40. */
export const scoreTone = (score: number): Tone => (score >= 70 ? 'ok' : score >= 40 ? 'warn' : 'bad');

const timeText = (iso: string): string => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

/** A user grade in one line: the score, who and when, and the note. */
export const userGradeText = (g: UserGrade): string => `${g.score} of 5 by ${g.by}, ${timeText(g.at)}${g.note ? `: ${g.note}` : ''}`;

/** What grade-aware routing does now, in one sentence. */
export function gradeSettingsSummary(s: GradeSettings): string {
  if (!s.routing.on) return 'Grade-aware routing is off: grades are kept and shown, and intake does not read them.';
  return `Grade-aware routing is on: intake gives a new job the executor graded best on matching work, when each executor has ${s.routing.minSamples} graded jobs there.`;
}

export interface GradeSettingsDraft {
  weights: Record<GradeSignal, string>; revertWindowDays: string; costScaleUsd: string; timeScaleMinutes: string; routingOn: boolean; minSamples: string;
}
export interface GradeSettingsPatch {
  weights?: Partial<Record<GradeSignal, number>>; revertWindowDays?: number; costScaleUsd?: number; timeScaleMinutes?: number;
  routing?: { on?: boolean; minSamples?: number };
}

export const draftOf = (s: GradeSettings): GradeSettingsDraft => ({
  weights: Object.fromEntries(SIGNALS.map((g) => [g, String(s.weights[g])])) as Record<GradeSignal, string>,
  revertWindowDays: String(s.revertWindowDays), costScaleUsd: String(s.costScaleUsd), timeScaleMinutes: String(s.timeScaleMinutes),
  routingOn: s.routing.on, minSamples: String(s.routing.minSamples),
});

/** The number a field holds, when it is in the daemon's range (`whole`: an integer only). */
function numberIn(text: string, ok: (n: number) => boolean, whole = false): number | undefined {
  const t = text.trim();
  const n = Number(t);
  return t !== '' && Number.isFinite(n) && (!whole || Number.isInteger(n)) && ok(n) ? n : undefined;
}

/** The change a save sends: only what differs, each weight on its own (undefined: nothing to save), or why the draft is refused. */
export function gradeSettingsPatch(s: GradeSettings, d: GradeSettingsDraft): { ok: true; patch: GradeSettingsPatch | undefined } | { ok: false; error: string } {
  const weights: Partial<Record<GradeSignal, number>> = {};
  for (const g of SIGNALS) {
    const w = numberIn(d.weights[g], (n) => n >= 0 && n <= 100);
    if (w === undefined) return { ok: false, error: `Weight of ${SIGNAL_NAMES[g]}: a number from 0 to 100` };
    if (w !== s.weights[g]) weights[g] = w;
  }
  const days = numberIn(d.revertWindowDays, (n) => n >= 1 && n <= 90, true);
  if (days === undefined) return { ok: false, error: 'Revert window: a whole number of days from 1 to 90' };
  const cost = numberIn(d.costScaleUsd, (n) => n > 0 && n <= 10_000);
  if (cost === undefined) return { ok: false, error: 'Cost scale: a number above 0, up to 10000' };
  const time = numberIn(d.timeScaleMinutes, (n) => n >= 1 && n <= 10_080, true);
  if (time === undefined) return { ok: false, error: 'Time scale: a whole number of minutes from 1 to 10080' };
  const min = numberIn(d.minSamples, (n) => n >= 1 && n <= 10_000, true);
  if (min === undefined) return { ok: false, error: 'Minimum graded jobs: a whole number from 1 to 10000' };
  const routing = { ...(d.routingOn === s.routing.on ? {} : { on: d.routingOn }), ...(min === s.routing.minSamples ? {} : { minSamples: min }) };
  const patch: GradeSettingsPatch = {
    ...(Object.keys(weights).length ? { weights } : {}), ...(days === s.revertWindowDays ? {} : { revertWindowDays: days }),
    ...(cost === s.costScaleUsd ? {} : { costScaleUsd: cost }), ...(time === s.timeScaleMinutes ? {} : { timeScaleMinutes: time }),
    ...(Object.keys(routing).length ? { routing } : {}),
  };
  return { ok: true, patch: Object.keys(patch).length > 0 ? patch : undefined };
}
