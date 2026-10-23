// Delivery forecasts in the UI (issue #2554 part 7), pure: a forecast's times on the owner's wall clock — the time zone of
// the repository's promotion set schedule —, the query a person's text names (an issue, a pull request URL or a job id),
// and the gates of a promotion set a person can clear.
import type { DeliveryForecast, DeliverySettings, StepForecast } from './wire.ts';

type Step = StepForecast['step'];

const LABELS: Record<Step, string> = {
  queued: 'Queued', coding: 'Coding', pr_checks: 'PR checks', landing: 'Landing', landing_checks: 'Landing checks',
  promotion_set: 'Promotion set', test_gate: 'Test gate', production: 'Production',
};
export const stepLabel = (s: Step): string => LABELS[s];

/** `Thu 22 Oct 14:00` in `timeZone`. */
export function zonedTime(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(iso));
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('weekday')} ${get('day')} ${get('month')} ${get('hour')}:${get('minute')}`;
}

/** The two largest of days, hours and minutes. */
export function durationText(ms: number): string {
  const min = Math.round(ms / 60_000);
  const parts = [[Math.floor(min / 1440), 'd'], [Math.floor(min / 60) % 24, 'h'], [min % 60, 'min']] as const;
  const first = parts.findIndex(([n]) => n > 0);
  if (first < 0) return '0 min';
  return parts.slice(first, first + 2).filter(([n]) => n > 0).map(([n, u]) => `${n} ${u}`).join(' ');
}

/** The repository's schedule time zone, else `fallback` (the browser's). */
export const timeZoneOf = (s: DeliverySettings, repo: string | undefined, fallback: string): string =>
  (repo ? s.repos[repo.toLowerCase()]?.schedule?.timeZone : undefined) ?? fallback;

/** The forecast query the text names: `owner/repo#N` an issue, an http(s) URL a pull request, else a job id. */
export function changeQuery(text: string): string | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const k = /^[\w.-]+\/[\w.-]+#\d+$/.test(t) ? 'issue' : /^https?:\/\//.test(t) ? 'pr' : 'job';
  return new URLSearchParams({ [k]: t }).toString();
}

export interface ForecastRow {
  step: Step;
  label: string;
  current: boolean;
  start?: string;
  end?: string;
  endP90?: string;
  set?: string;
  basis: string;
  gate?: string;
}

/** Each step left of the normal path, its times in `timeZone`. */
export function forecastRows(f: DeliveryForecast, timeZone: string): ForecastRow[] {
  return f.normal.steps.map((s) => {
    const row: ForecastRow = {
      step: s.step, label: stepLabel(s.step), current: s.step === f.step,
      basis: s.basis === 'unknown' ? 'too little history' : s.basis === 'measured' ? `measured, ${s.samples ?? 0} samples` : 'scheduled',
    };
    if (s.start) row.start = zonedTime(s.start, timeZone);
    if (s.end) row.end = zonedTime(s.end, timeZone);
    if (s.endP90) row.endP90 = zonedTime(s.endP90, timeZone);
    if (s.set !== undefined) row.set = s.setP90 !== undefined && s.setP90 !== s.set ? `set ${s.set} (p90: ${s.setP90})` : `set ${s.set}`;
    if (s.gate) row.gate = s.gate.owner;
    return row;
  });
}

/** The gated steps left: each one a person can clear for the promotion set. */
export const gatesToClear = (f: DeliveryForecast | undefined): { step: Step; owner: string }[] =>
  (f?.normal.steps ?? []).flatMap((s) => (s.gate ? [{ step: s.step, owner: s.gate.owner }] : []));
