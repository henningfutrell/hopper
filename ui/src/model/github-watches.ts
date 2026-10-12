// GitHub watches in the UI (issue #427), pure: the interval in words, the change a save sends, and one line per watch.
import type { GitHubWatch } from './wire.ts';

export const INTERVAL = { min: 10, max: 86_400 } as const;

/** Seconds as minutes and seconds. */
export function intervalWords(seconds: number): string {
  const m = Math.floor(seconds / 60), s = seconds % 60;
  return m === 0 ? `${s} s` : `${m} min${s ? ` ${s} s` : ''}`;
}

/** The change a save sends (undefined: nothing to save), or why the draft is refused. */
export function intervalPatch(saved: number, draft: string): { ok: true; patch: { intervalSeconds: number } | undefined } | { ok: false; error: string } {
  const text = draft.trim(), n = Number(text);
  if (text === '' || !Number.isInteger(n) || n < INTERVAL.min || n > INTERVAL.max) return { ok: false, error: `Interval: a whole number of seconds from ${INTERVAL.min} to ${INTERVAL.max}` };
  return { ok: true, patch: n === saved ? undefined : { intervalSeconds: n } };
}

/** One watch: its item, then what the last poll saw and when, or why it cannot poll. */
export function watchLine(w: GitHubWatch): string {
  const item = `${w.repo}#${w.pointer.number}`;
  if (w.error) return `${item}: ${w.error}`;
  if (!w.snapshot || !w.polledAt) return `${item}: not polled yet`;
  const s = w.snapshot, n = s.comments.length;
  const parts = [s.state, ...(s.labels.length ? [`labels ${s.labels.join(', ')}`] : []), `${n} comment${n === 1 ? '' : 's'}`];
  return `${item}: ${parts.join(', ')}; polled ${w.polledAt.slice(0, 19).replace('T', ' ')} UTC`;
}
