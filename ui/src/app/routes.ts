// The routes, by URL hash so a link (#questions) and the back button work. A view may have sections after a slash
// (#settings/routing): the view is the part before it. Each workflow has one canonical home (issue #2374): views that
// showed the same data are one nav entry, a merged page, whose tabs (#approvals/pending-approvals) filter that one
// workflow. Every old view name opens its new home (MOVED), what follows it kept (#direct-queries/<id> →
// #ask/direct-queries/<id>), and the hash is replaced by the canonical one.
import { useEffect, useSyncExternalStore } from 'react';
import { SECTION_KINDS } from '@/model/sections';

export const VIEWS = ['dashboard', 'needs-you', 'intake', 'questions', 'proposals', 'approvals', 'failures', 'tagged', 'jobs', 'pull-requests', 'research', 'ask', 'artifacts', 'activity', 'machines', 'usage', 'sources', 'infra', 'topology', 'vault', 'users-access', 'skills', 'plugins', 'settings'] as const;
/** The routes: every view in the navigation, and those with no nav entry — the job view (timeline entries link to it),
 *  Search (the header's search box opens it) and Your reports (the user menu links to it). */
const ROUTES = [...VIEWS, 'job', 'search', 'reports'] as const;
export type View = (typeof ROUTES)[number];
/** The views above the nav groups, always shown. */
export const NAV_PINNED = ['dashboard', 'needs-you'] as const satisfies readonly (typeof VIEWS)[number][];
/** The nav groups, in nav order, each with its entries in order. Their ids stay when a label changes (issue #2374:
 *  Work, Fleet and Admin keep `jobs`, `sources-machines` and `settings`), so a collapsed group stays collapsed. A view of the navigation neither pinned nor in a group, or a group of one entry, fails the typecheck. */
export const NAV_GROUPS = [
  { id: 'waiting', label: 'Waiting on you', views: ['intake', 'questions', 'proposals', 'approvals', 'failures', 'tagged'] },
  { id: 'jobs', label: 'Work', views: ['jobs', 'pull-requests', 'research', 'ask', 'artifacts', 'activity'] },
  { id: 'sources-machines', label: 'Fleet', views: ['machines', 'usage', 'sources'] },
  { id: 'infra', label: 'Infra', views: ['infra', 'topology', 'vault'] },
  { id: 'settings', label: 'Admin', views: ['users-access', 'skills', 'plugins', 'settings'] },
] as const satisfies readonly { id: string; label: string; views: readonly [(typeof VIEWS)[number], (typeof VIEWS)[number], ...(typeof VIEWS)[number][]] }[];
const everyViewGrouped: Exclude<(typeof VIEWS)[number], (typeof NAV_GROUPS)[number]['views'][number] | (typeof NAV_PINNED)[number]> extends never ? true : never = true;
void everyViewGrouped;

/** The merged pages and their tabs, the first the default. A tab's id is the view it was before the merge. */
export const PAGE_TABS = {
  approvals: [{ id: 'access-requests', label: 'Access requests' }, { id: 'pending-approvals', label: 'Pending approvals' }],
  failures: [{ id: 'failures', label: 'Failures' }, { id: 'parked', label: 'Parked' }],
  jobs: [{ id: 'jobs', label: 'Jobs' }, { id: 'queue', label: 'Queue order' }],
  ask: [{ id: 'direct-jobs', label: 'Run a job' }, { id: 'direct-queries', label: 'Ask a question' }],
  activity: [{ id: 'events', label: 'Events' }, { id: 'decisions', label: 'Decisions' }],
  machines: [{ id: 'machines', label: 'Machines' }, { id: 'accounts', label: 'Accounts' }, { id: 'logins', label: 'Logins' }],
  usage: [{ id: 'usage', label: 'Usage' }, { id: 'resources', label: 'Resources' }],
} as const satisfies Partial<Record<(typeof VIEWS)[number], readonly { id: string; label: string }[]>>;
export type MergedPage = keyof typeof PAGE_TABS;
export type Tab = (typeof PAGE_TABS)[MergedPage][number]['id'];
/** Every section (issue #543) is a nav entry or a tab, so its badge shows. */
const everySectionShown: Exclude<(typeof SECTION_KINDS)[number], (typeof VIEWS)[number] | Tab> extends never ? true : never = true;
void everySectionShown;

/** Old view names and the hash each became, so an old link still opens it. Stuck work is first in Failures (issue #1010). */
const MOVED: Record<string, string> = {
  'not-taken': 'intake', overview: 'dashboard', stuck: 'failures',
  ...Object.fromEntries(Object.entries(PAGE_TABS).flatMap(([home, tabs]) => tabs.filter((t) => t.id !== home).map((t) => [t.id, `${home}/${t.id}`]))),
};

/** The canonical hash for a hash (without its #): an old view name becomes its new home, what follows it kept. */
export function canonicalHash(raw: string): string {
  const [head = '', ...rest] = raw.split('/');
  const to = MOVED[head];
  if (to !== undefined) return [to, ...rest].join('/');
  // #ask/question was the Ask a question tab before Ask hopper became a merged page (issue #2375).
  return head === 'ask' && rest[0] === 'question' ? ['ask', 'direct-queries', ...rest.slice(1)].join('/') : raw;
}

const subscribe = (fn: () => void) => { window.addEventListener('hashchange', fn); return () => window.removeEventListener('hashchange', fn); };
const parts = (): string[] => canonicalHash(window.location.hash.slice(1)).split('/');
const read = (): View => { const h = parts()[0]!; return (ROUTES as readonly string[]).includes(h) ? (h as View) : 'dashboard'; };
export const useView = (): View => useSyncExternalStore(subscribe, read);
/** The section after the view in the hash (#settings/routing → routing), or ''. */
const readSection = (): string => parts()[1] ?? '';
export const useSection = (): string => useSyncExternalStore(subscribe, readSection);

/** Replaces an old hash with its canonical one, so the address bar and a copied link name the new home. */
export function useCanonicalHash(): void {
  const raw = useSyncExternalStore(subscribe, () => window.location.hash.slice(1));
  useEffect(() => {
    const to = canonicalHash(raw);
    if (to !== raw) window.location.replace(`#${to}`);
  }, [raw]);
}

/** The tab a merged page shows: the one the hash names, else its first. */
export const tabOf = (page: MergedPage, section: string): Tab =>
  (PAGE_TABS[page] as readonly { id: Tab }[]).find((t) => t.id === section)?.id ?? PAGE_TABS[page][0].id;
