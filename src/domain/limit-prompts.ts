// What an agent CLI shows when its account is at a limit (issue #2897, design.md "Limit prompts"): usage, rate, or access.
// One table: a new wording is one line here. The executor reads the pane with it, the failure text carries the line
// matched to the failure assessor (`agent-limit`, src/failures/causes.ts), and the reset time comes from that line. Pure.

export type LimitFamily = 'usage' | 'rate' | 'access';

/** A line of the agent CLI's that says its account is at a limit. */
export interface LimitPrompt { family: LimitFamily; prompt: string }

/**
 * Whole lines only: a job's own sentence about a limit, a tool's "no access to this repository" and the CLI's warnings
 * before a limit ("Approaching usage limit", "You've used 91% of …") do not match.
 */
export const LIMIT_PROMPTS: readonly { family: LimitFamily; pattern: RegExp }[] = [
  { family: 'usage', pattern: /^you(?:['’]ve| have)? (?:hit|reached|exceeded|used up) (?:your|the)\b.*\b(?:limit|quota|credits?)\b/i },
  { family: 'usage', pattern: /^(?:[\w-]+ ){0,3}limit (?:reached|exceeded)\s*(?:$|[.|·∙:,!—–-])/i },
  { family: 'usage', pattern: /^(?:please )?upgrade your plan\b.*\b(?:continue|keep|more|access)\b/i },
  { family: 'usage', pattern: /^\/upgrade to increase your usage limit/i },
  { family: 'usage', pattern: /^credit balance (?:is )?too low/i },
  { family: 'rate', pattern: /^(?:api error\b.*\b)?rate limit(?:ed)?\b.*\b(?:reached|exceeded)\b/i },
  { family: 'rate', pattern: /^you(?:['’]re| are) (?:being |currently )?rate.?limited\b/i },
  { family: 'access', pattern: /\bask your admin to enable access\b/i },
  { family: 'access', pattern: /^you (?:don['’]t|do not) have access to (?:claude|codex|cursor|gemini|fable|opus|sonnet|haiku|(?:this|the) (?:model|feature|product|plan)\b)/i },
  { family: 'access', pattern: /\bnot enabled for your (?:organi[sz]ation|org|account|team|workspace|plan)\b/i },
  { family: 'access', pattern: /^your (?:organi[sz]ation|org|account|team|plan) (?:does not|doesn['’]t) have access\b/i },
];

const GUTTER = /^[\s●⎿│]+/;
const LONGEST_LINE = 240;
/** How many of the last lines hold the prompt: more work after it means the agent went past it. */
const LAST_LINES = 4;

/** The limit prompt among the last `last` lines that are not blank, the newest first; undefined: none. */
export function limitPromptIn(lines: readonly string[], last = LAST_LINES): LimitPrompt | undefined {
  const tail = lines.map((l) => l.replace(GUTTER, '').trimEnd()).filter(Boolean).slice(-last).reverse();
  for (const prompt of tail) {
    if (prompt.length > LONGEST_LINE) continue;
    const hit = LIMIT_PROMPTS.find((p) => p.pattern.test(prompt));
    if (hit) return { family: hit.family, prompt };
  }
  return undefined;
}

const FAILURE = /^usage or access limit \((usage|rate|access)\): the agent stopped at: (.*)$/;

/** The job's failure text: what the failure assessor knows it by, and what the job's events say. */
export const limitFailure = (p: LimitPrompt): string => `usage or access limit (${p.family}): the agent stopped at: ${p.prompt}`;

/** The limit prompt a failure text names; undefined: any other failure. */
export function limitPromptOfFailure(error: string): LimitPrompt | undefined {
  const m = FAILURE.exec(error);
  return m ? { family: m[1] as LimitFamily, prompt: m[2]! } : undefined;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** A reset further off than this is a misread, not a reset: a monthly limit is the longest there is. */
const LONGEST_RESET_MS = 35 * 86_400_000;

/** The instant the wall clock `y-m-d h:i` reads in `zone`. Throws on a zone Intl does not know. */
function zoned(y: number, mo: number, d: number, h: number, mi: number, zone: string): number {
  const guess = Date.UTC(y, mo, d, h, mi);
  const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(guess));
  const of = (t: string): number => Number(part.find((p) => p.type === t)!.value);
  return guess - (Date.UTC(of('year'), of('month') - 1, of('day'), of('hour'), of('minute')) - guess);
}

/** A wall clock time with its zone in parentheses, as Claude Code prints it; a time with no zone cannot be placed. */
function wallClock(text: string, now: Date): number | undefined {
  const m = /\breset(?:s|ting)?(?: at| on)? (?:([a-z]{3})[a-z]* (\d{1,2})(?:,| at)? +)?(\d{1,2})(?::(\d{2}))? ?(am|pm)?\s*\(([^)]+)\)/i.exec(text);
  if (!m) return undefined;
  const hour = (Number(m[3]) % (m[5] ? 12 : 24)) + (m[5]?.toLowerCase() === 'pm' ? 12 : 0);
  const minute = Number(m[4] ?? 0);
  const zone = m[6]!.trim();
  try {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(now);
    const of = (t: string): number => Number(today.find((p) => p.type === t)!.value);
    const month = m[1] ? MONTHS.indexOf(m[1].toLowerCase()) : of('month') - 1;
    if (month < 0) return undefined;
    const day = m[2] ? Number(m[2]) : of('day');
    const at = zoned(of('year'), month, day, hour, minute, zone);
    if (at > now.getTime()) return at;
    return m[1] ? zoned(of('year') + 1, month, day, hour, minute, zone) : zoned(of('year'), month, day + 1, hour, minute, zone);
  } catch { return undefined; }
}

/** The time after a relative wait: "in 2 hours", "in 1h 30m". */
function relative(text: string, now: Date): number | undefined {
  const m = /\bin (?:(\d+) ?(?:h|hrs?|hours?)\b)? ?(?:(\d+) ?(?:m|mins?|minutes?)\b)?/i.exec(text);
  return m && (m[1] || m[2]) ? now.getTime() + Number(m[1] ?? 0) * 3_600_000 + Number(m[2] ?? 0) * 60_000 : undefined;
}

/** When the limit resets, as `text` names it (ISO); undefined: it names no time, or none that can be trusted. */
export function limitResetOf(text: string, now: Date): string | undefined {
  const epoch = /\|(\d{10})\b/.exec(text)?.[1];
  const iso = /\b\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})/.exec(text)?.[0];
  const at = epoch ? Number(epoch) * 1000 : iso ? Date.parse(iso) : wallClock(text, now) ?? relative(text, now);
  return at !== undefined && at > now.getTime() && at - now.getTime() <= LONGEST_RESET_MS ? new Date(at).toISOString() : undefined;
}

/** How long a limit whose prompt names no reset is taken to hold: then a job finds out again, at the cost of a moment. */
export const LIMIT_RECHECK_MS: Readonly<Record<LimitFamily, number>> = { usage: 3_600_000, rate: 600_000, access: 3_600_000 };
