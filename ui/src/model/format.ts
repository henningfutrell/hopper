// How the UI writes times. `now` is passed in, so every function is pure.

export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  return m ? `${m}m ${s % 60}s` : `${s}s`;
}

export const elapsed = (fromIso: string, now: number): string => duration((now - Date.parse(fromIso)) / 1000);

export function between(a?: string, b?: string): string {
  return a && b ? duration((Date.parse(b) - Date.parse(a)) / 1000) : '';
}

export function ago(iso: string | undefined, now: number): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function countdown(iso: string, now: number): string {
  const s = (Date.parse(iso) - now) / 1000;
  return s <= 0 ? 'expired' : `in ${duration(s)}`;
}

export const clock = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour12: false });
