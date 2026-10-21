// Page choices (issue #2353): how a long page shows its items — a mode (cards or one-line rows, a graph or a list) and
// which groups are folded —, kept per browser (hooks/use-page-pref.ts) so a reload keeps them. Each choice is one key,
// `<page>.<what>` (`jobs.mode`, `pull-requests.group.acme/widgets`), and one short string. What is read back is checked,
// never trusted; the newest choices are kept when there are too many. Paging is here too: a page of a long list.

/** The most choices kept: a group a person folded once is a key, and groups come and go. */
export const MAX_PREFS = 400;

export type PagePrefs = Readonly<Record<string, string>>;

/** The choices as browser storage has them; anything not an object of strings is dropped. */
export function parsePrefs(raw: string | null): PagePrefs {
  if (raw === null) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch { return {}; }
}

/** The choices with `key` set to `value` as the newest; the oldest go past MAX_PREFS. */
export function setPref(prefs: PagePrefs, key: string, value: string): PagePrefs {
  const { [key]: _old, ...rest } = prefs;
  const entries = [...Object.entries(rest), [key, value] as const];
  return Object.fromEntries(entries.slice(Math.max(0, entries.length - MAX_PREFS)));
}

/** A choice read back: one of `allowed`, else the fallback. */
export const prefOf = <T extends string>(prefs: PagePrefs, key: string, fallback: T, allowed: readonly T[]): T => {
  const v = prefs[key];
  return v !== undefined && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
};

/** How many items a page shows: one-line rows, and cards. */
export const ROWS_PER_PAGE = 40;
export const CARDS_PER_PAGE = 10;

export interface Page<T> { shown: T[]; page: number; pages: number; from: number; to: number; total: number }

/** Page `page` (from 0, kept inside the pages there are) of `items`, `size` to a page. */
export function pageOf<T>(items: readonly T[], page: number, size: number): Page<T> {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(Math.max(0, Math.floor(page)), pages - 1);
  const shown = items.slice(p * size, (p + 1) * size);
  return { shown, page: p, pages, from: items.length ? p * size + 1 : 0, to: p * size + shown.length, total: items.length };
}
