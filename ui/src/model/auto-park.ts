// Auto-park in the UI (issue #650), pure: the summary of the timeouts, the change a save sends, and whether the answer
// to a parked job's question picks the job up by itself.
import type { AutoParkSettings, Job } from './wire.ts';

/** The longest timeout, a week in minutes, as the daemon allows it. */
const MAX_MINUTES = 7 * 24 * 60;

export interface AutoParkDraft { minutes: string; highPriorityMinutes: string }
export type AutoParkPatch = Partial<AutoParkSettings>;

const wait = (m: number): string => (m >= 1 ? `${Math.round(m * 10) / 10} min` : `${Math.round(m * 600) / 10} s`);

/** What is on now, in one sentence. */
export function autoParkSummary(s: AutoParkSettings): string {
  const { minutes: m, highPriorityMinutes: h } = s;
  if (m === 0 && h === 0) return 'Off: no job parks by itself.';
  if (m === 0) return `Only a high-priority job parks by itself, when its question waits on a person for ${wait(h)}.`;
  const base = `A job parks by itself when its question waits on a person for ${wait(m)}`;
  if (h === m) return `${base}.`;
  return h === 0 ? `${base}; a high-priority job never does.` : `${base}; a high-priority job after ${wait(h)}.`;
}

function minutesOf(label: string, raw: string): { ok: true; value: number } | { ok: false; error: string } {
  const text = raw.trim();
  const n = Number(text);
  return text !== '' && Number.isFinite(n) && n >= 0 && n <= MAX_MINUTES ? { ok: true, value: n } : { ok: false, error: `${label}: a number from 0 to ${MAX_MINUTES}` };
}

/** The change a save sends: only what differs (undefined: nothing to save), or why the draft is refused. */
export function autoParkPatch(s: AutoParkSettings, d: AutoParkDraft): { ok: true; patch: AutoParkPatch | undefined } | { ok: false; error: string } {
  const minutes = minutesOf('Minutes', d.minutes);
  if (!minutes.ok) return minutes;
  const high = minutesOf('High-priority minutes', d.highPriorityMinutes);
  if (!high.ok) return high;
  const patch: AutoParkPatch = {
    ...(minutes.value === s.minutes ? {} : { minutes: minutes.value }),
    ...(high.value === s.highPriorityMinutes ? {} : { highPriorityMinutes: high.value }),
  };
  return { ok: true, patch: Object.keys(patch).length > 0 ? patch : undefined };
}

/** Auto-park parked it: the answer to its question picks it up, with no Pick up. */
export const answerPicksUp = (job: Pick<Job, 'parked'>): boolean => job.parked?.auto === true;
