// The nav groups (issue #906): the main menu's entries in groups a person collapses. A collapsed group hides its entries,
// never their badges: it shows them as one — the counts summed, the high-priority ones summed, the most urgent colour —
// and a backburner count summed on its own. Open, each entry shows its own badge. Which groups are collapsed is kept per
// browser (hooks/use-nav-collapsed.ts); what is read back is checked, never trusted.

export interface NavBadge { n: number; cls: string; title?: string; high?: number }
/** One nav entry as its group needs it: its label, its badge, and its backburner count (Intake). */
export interface NavEntry { view: string; label: string; badge?: NavBadge; backburner?: number }
export interface NavGroupBadges { badge?: NavBadge; backburner?: number }

/** The badge colours, most urgent first: a failure, then a warning, a decision, a plain count, a quiet one. */
const URGENCY = ['bg-bad', 'bg-warn', 'bg-question', 'bg-foreground', 'bg-muted'] as const;

/** How urgent a badge's colour is: higher is more urgent; a colour not listed is the least. */
export function badgeUrgency(cls: string): number {
  const words = cls.split(/\s+/);
  const i = URGENCY.findIndex((c) => words.includes(c));
  return i < 0 ? 0 : URGENCY.length - i;
}

/** Badges with a count summed: the counts, the high-priority ones, the most urgent colour, and each one's title, after its label when it has one. */
function sum(counted: readonly { label?: string; badge: NavBadge }[]): NavBadge {
  const n = counted.reduce((t, e) => t + e.badge.n, 0);
  const high = counted.reduce((t, e) => t + (e.badge.high ?? 0), 0);
  const cls = counted.reduce((best, e) => (badgeUrgency(e.badge.cls) > badgeUrgency(best) ? e.badge.cls : best), counted[0]!.badge.cls);
  const title = counted.map((e) => (e.label ? `${e.label}: ${e.badge.title ?? e.badge.n}` : e.badge.title ?? String(e.badge.n))).join('; ');
  return high > 0 ? { n, high, cls, title } : { n, cls, title };
}

const hasCount = (b: NavBadge | undefined): b is NavBadge => b !== undefined && b.n > 0;

/** A group's badges, from its entries': each entry with a count is in the sum and in the title. */
export function groupBadges(entries: readonly NavEntry[]): NavGroupBadges {
  const counted = entries.flatMap((e) => (hasCount(e.badge) ? [{ label: e.label, badge: e.badge }] : []));
  const out: NavGroupBadges = {};
  if (counted.length > 0) out.badge = sum(counted);
  const backburner = entries.reduce((t, e) => t + (e.backburner ?? 0), 0);
  if (backburner > 0) out.backburner = backburner;
  return out;
}

/** A merged page's badge (issue #2374), from its tabs': the same sum, each tab's title as it is, since each names what it counts. */
export function mergedBadge(tabs: readonly (NavBadge | undefined)[]): NavBadge | undefined {
  const counted = tabs.filter(hasCount).map((badge) => ({ badge }));
  return counted.length > 0 ? sum(counted) : undefined;
}

/** The collapsed groups' ids as browser storage has them; anything not a list of strings is none. */
export function parseCollapsed(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

export const toggleCollapsed = (collapsed: readonly string[], id: string): string[] =>
  collapsed.includes(id) ? collapsed.filter((c) => c !== id) : [...collapsed, id];
