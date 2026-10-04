// What `claude -p /usage --output-format json` and `claude auth status --json` print, read into
// usage windows and an account. Pure: `now` is passed in. Prior art: a status-bar script.
//   Current session: 1% used · resets Aug 8, 2:10pm (America/Chicago)
//   Current week (all models): 27% used · resets Aug 11, 12pm (America/Chicago)
//   Current week (Fable): 16% used · resets Aug 11, 12pm (America/Chicago)
// The session and the week of all models limit every job, so they throttle lanes; any other
// window (one model's week, or a shape not known here) limits less than every job and is
// informational — shown, never throttling.
import type { Account } from '../../../domain/types.ts';

export interface PlanWindow {
  window: string;
  used: number;
  resetsAt?: string;
  informational?: true;
}

const LINE = /^Current (?<label>.+?):\s*(?<pct>\d+(?:\.\d+)?)%\s*used(?:.*?resets\s+(?<when>.+?))?\s*$/;
const WHEN = /^(?<stamp>.+?)\s*\((?<tz>[^)]+)\)$/;
const STAMP = /^(?:(?<mon>[a-z]{3})[a-z]*\.?\s+(?<day>\d{1,2}),?\s+)?(?<h>\d{1,2})(?::(?<m>\d{2}))?\s*(?<ap>am|pm)?$/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** The panel's labels for the windows that limit every job, and the window names they get. */
const THROTTLING: Record<string, string> = { session: 'session', 'week (all models)': 'week' };
const ORDER = ['session', 'week'];

/** The wall clock in `tz` at `utcMs`, as if it were UTC, minus `utcMs`: the zone's offset. Throws on an unknown zone. */
function offsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - utcMs;
}

/** A wall-clock time in `tz` as epoch ms (twice round, so a DST edge lands right). */
function zoned(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const wall = Date.UTC(y, mo, d, h, mi);
  const first = wall - offsetMs(wall, tz);
  return wall - offsetMs(first, tz);
}

/** `Aug 11, 12pm (America/Chicago)` → ISO. The year is not printed: the one nearest `now`. No date → the next such time. */
export function resetsAtOf(when: string, now: Date): string | undefined {
  const w = WHEN.exec(when.trim());
  const s = w && STAMP.exec(w.groups!.stamp!.trim());
  if (!w || !s) return undefined;
  const tz = w.groups!.tz!.trim();
  const g = s.groups!;
  const ap = g.ap?.toLowerCase();
  let h = Number(g.h);
  if (ap) {
    if (h < 1 || h > 12) return undefined;
    h = (h % 12) + (ap === 'pm' ? 12 : 0);
  } else if (g.m === undefined || h > 23) return undefined;
  const mi = Number(g.m ?? 0);
  try {
    const here = new Date(now.getTime() + offsetMs(now.getTime(), tz));
    if (g.mon === undefined) {
      const today = zoned(here.getUTCFullYear(), here.getUTCMonth(), here.getUTCDate(), h, mi, tz);
      return new Date(today > now.getTime() ? today : zoned(here.getUTCFullYear(), here.getUTCMonth(), here.getUTCDate() + 1, h, mi, tz)).toISOString();
    }
    const mo = MONTHS.indexOf(g.mon.toLowerCase());
    if (mo < 0) return undefined;
    const y = here.getUTCFullYear();
    const near = [y - 1, y, y + 1].map((yy) => zoned(yy, mo, Number(g.day), h, mi, tz))
      .reduce((a, b) => (Math.abs(b - now.getTime()) < Math.abs(a - now.getTime()) ? b : a));
    return new Date(near).toISOString();
  } catch {
    return undefined; // an unknown time zone
  }
}

/** The usage panel's text → its windows: the session, the week, then the informational ones as printed. */
export function parseUsageText(text: string, now: Date): PlanWindow[] {
  const out: PlanWindow[] = [];
  for (const line of text.split('\n')) {
    const m = LINE.exec(line.trim());
    if (!m) continue;
    const label = m.groups!.label!.trim();
    const window = THROTTLING[label];
    const resetsAt = m.groups!.when ? resetsAtOf(m.groups!.when, now) : undefined;
    out.push({
      window: window ?? label, used: Number(m.groups!.pct),
      ...(resetsAt ? { resetsAt } : {}), ...(window ? {} : { informational: true as const }),
    });
  }
  const rank = (w: PlanWindow) => (w.informational ? ORDER.length : ORDER.indexOf(w.window));
  return out.map((w, i) => ({ w, i })).sort((a, b) => rank(a.w) - rank(b.w) || a.i - b.i).map((x) => x.w);
}

const firstLine = (text: string) => text.split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 200);

/** stdout of `claude -p /usage --output-format json` → its windows, or why there are none. */
export function parseUsageEnvelope(stdout: string, now: Date): { windows: PlanWindow[] } | { problem: string } {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return { problem: 'claude output is not JSON' };
  }
  if (typeof json !== 'object' || json === null) return { problem: 'claude output is not JSON' };
  const env = json as { is_error?: unknown; result?: unknown };
  const result = typeof env.result === 'string' ? env.result : '';
  const windows = env.is_error === true ? [] : parseUsageText(result, now);
  // Claude Code prints the header alone when the usage service refuses.
  if (windows.length === 0) return { problem: `usage unavailable: ${firstLine(result) ?? 'empty result'}` };
  return { windows };
}

/** stdout of `claude auth status --json` → the account: email, plan, organization, sign-in method. Ids and anything else are dropped. */
export function parseAuthStatus(stdout: string): Account {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return { service: 'claude', detail: {}, problem: 'claude auth status: output is not JSON' };
  }
  const a = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>;
  if (a.loggedIn !== true) return { service: 'claude', detail: {}, problem: 'not logged in' };
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
  const detail: Record<string, string> = {};
  for (const [key, from] of [['plan', 'subscriptionType'], ['organization', 'orgName'], ['authMethod', 'authMethod']] as const) {
    const v = str(a[from]);
    if (v) detail[key] = v;
  }
  const identity = str(a.email);
  return { service: 'claude', ...(identity ? { identity } : {}), detail };
}
