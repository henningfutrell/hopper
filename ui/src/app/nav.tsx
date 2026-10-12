// The views, routed by URL hash so a link (#questions) and the back button work. A view may have
// sections after a slash (#settings/routing): the view is the part before it. Each section (Questions, Proposals,
// Research, Logins, Failures, Parked; issues #543, #565) is a view whose badge follows the one section rule (useSectionBadges).
// The Jobs view (issue #434) has a card per job. Needs you (issue #897) comes first: its badge counts every decision that waits on a
// person. Intake (issue #897; it was Not taken, issue #798) is badged with the request cards waiting for approval, Access requests
// with what jobs on boxes wait for. An old link (#not-taken) opens the view it became (MOVED). The job view (#job/<id>, issue #433) is a
// route with no nav entry: timeline entries link to it. Infra (issue #896) holds plans, applies and out-of-band changes, and is badged
// with the plans that wait for an admin; Pull requests with the ones that have merge conflicts (issue #897).
// The entries are in nav groups (issue #906, model/nav-groups.ts): a collapsed group shows its entries' badges as one. Needs you is
// pinned above them, never collapsed: its badge already sums other entries', so no group sums it again.
import { BellRing, Briefcase, ChevronDown, ChevronsUp, CircleDashed, FileCheck, FileDiff, Flame, FolderOpen, Gauge, GitPullRequest, Inbox, KeyRound, LayoutDashboard, LayoutGrid, ListOrdered, ListTree, Menu, MessageCircleQuestion, OctagonAlert, CirclePause, Scale, Server, Settings, ShieldQuestion, Telescope, type LucideIcon } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { useHopper } from '@/store';
import { useAwaitingSort, useSectionBadges } from '@/store/selectors';
import { useNeedsYou } from '@/store/needs-you';
import { needsYouTotal } from '@/model/needs-you';
import { SECTION_KINDS } from '@/model/sections';
import { onTheBackburner, requestsWaiting } from '@/model/intake';
import { groupBadges, type NavBadge } from '@/model/nav-groups';
import { toggleNavGroup, useNavCollapsed } from '@/hooks/use-nav-collapsed';
import { cn } from '@/lib/utils';

export const VIEWS = ['needs-you', 'overview', 'jobs', 'queue', 'intake', 'access-requests', ...SECTION_KINDS, 'pull-requests', 'artifacts', 'decisions', 'events', 'sources', 'machines', 'infra', 'usage', 'settings'] as const;
/** The routes: every view in the navigation, and the job view, which has no nav entry. */
const ROUTES = [...VIEWS, 'job'] as const;
export type View = (typeof ROUTES)[number];
/** The views above the nav groups, always shown. */
export const NAV_PINNED = ['needs-you'] as const satisfies readonly (typeof VIEWS)[number][];
/** The nav groups, in nav order, each with its entries in order. A view of the navigation neither pinned nor in a group fails the typecheck. */
export const NAV_GROUPS = [
  { id: 'waiting', label: 'Waiting on you', views: ['intake', 'access-requests', ...SECTION_KINDS] },
  { id: 'jobs', label: 'Jobs', views: ['overview', 'jobs', 'queue', 'pull-requests', 'artifacts', 'decisions', 'events'] },
  { id: 'infra', label: 'Infra', views: ['infra'] },
  { id: 'sources-machines', label: 'Sources & machines', views: ['sources', 'machines', 'usage'] },
  { id: 'settings', label: 'Settings', views: ['settings'] },
] as const satisfies readonly { id: string; label: string; views: readonly (typeof VIEWS)[number][] }[];
const everyViewGrouped: Exclude<(typeof VIEWS)[number], (typeof NAV_GROUPS)[number]['views'][number] | (typeof NAV_PINNED)[number]> extends never ? true : never = true;
void everyViewGrouped;
const ITEMS: Record<View, { label: string; icon: LucideIcon }> = {
  'needs-you': { label: 'Needs you', icon: BellRing },
  overview: { label: 'Overview', icon: LayoutDashboard },
  jobs: { label: 'Jobs', icon: LayoutGrid },
  queue: { label: 'Queue', icon: ListOrdered },
  intake: { label: 'Intake', icon: CircleDashed },
  'access-requests': { label: 'Access requests', icon: ShieldQuestion },
  questions: { label: 'Questions', icon: MessageCircleQuestion },
  proposals: { label: 'Proposals', icon: FileCheck },
  research: { label: 'Research', icon: Telescope },
  logins: { label: 'Logins', icon: KeyRound },
  failures: { label: 'Failures', icon: OctagonAlert },
  parked: { label: 'Parked', icon: CirclePause },
  'pull-requests': { label: 'Pull requests', icon: GitPullRequest },
  artifacts: { label: 'Artifacts', icon: FolderOpen },
  decisions: { label: 'Decisions', icon: Scale },
  events: { label: 'Events', icon: ListTree },
  sources: { label: 'Sources', icon: Inbox },
  machines: { label: 'Machines', icon: Server },
  infra: { label: 'Infra', icon: FileDiff },
  usage: { label: 'Usage', icon: Gauge },
  settings: { label: 'Settings', icon: Settings },
  job: { label: 'Job', icon: Briefcase },
};

const subscribe = (fn: () => void) => { window.addEventListener('hashchange', fn); return () => window.removeEventListener('hashchange', fn); };
/** Old view names and the view each became, so an old link still opens it. */
const MOVED: Record<string, View> = { 'not-taken': 'intake' };
const read = (): View => { const h = window.location.hash.slice(1).split('/')[0]!; return MOVED[h] ?? ((ROUTES as readonly string[]).includes(h) ? (h as View) : 'overview'); };
export const useView = (): View => useSyncExternalStore(subscribe, read);
/** The section after the view in the hash (#settings/routing → routing), or ''. */
const readSection = (): string => window.location.hash.slice(1).split('/')[1] ?? '';
export const useSection = (): string => useSyncExternalStore(subscribe, readSection);

function Links({ view, onPick }: { view: View; onPick?: () => void }) {
  const failedSources = useHopper((s) => s.sources.filter((x) => x.state === 'error').length);
  const requests = useHopper((s) => requestsWaiting(s.sources));
  const backburner = useHopper((s) => onTheBackburner(s.sources));
  const sorting = useAwaitingSort();
  // Every section's badge by the one rule; a high-priority item waiting (issue #535) marks it and says how many.
  const sections = useSectionBadges();
  const rows = useNeedsYou();
  const total = needsYouTotal(rows);
  const n = (k: (typeof rows)[number]['kind']): number => rows.find((r) => r.kind === k)!.n;
  const access = n('access');
  const plans = n('plans');
  const conflicts = n('pull-requests');
  const badge: Partial<Record<View, NavBadge>> = {
    queue: { n: sorting, cls: 'bg-warn text-background', title: `${sorting} ${sorting === 1 ? 'job waits' : 'jobs wait'} on the pre-sort` },
    'needs-you': { n: total.n, high: total.high, cls: 'bg-warn text-background', title: `${total.n} ${total.n === 1 ? 'decision waits' : 'decisions wait'} on you` },
    intake: { n: requests, cls: 'bg-warn text-background', title: `${requests} ${requests === 1 ? 'request waits' : 'requests wait'} for approval` },
    'access-requests': { n: access, cls: 'bg-warn text-background', title: `${access} ${access === 1 ? 'access request waits' : 'access requests wait'} on you` },
    ...sections,
    infra: { n: plans, cls: 'bg-warn text-background', title: `${plans} ${plans === 1 ? 'plan waits' : 'plans wait'} for an admin to approve` },
    'pull-requests': { n: conflicts, cls: 'bg-bad text-background', title: `${conflicts} ${conflicts === 1 ? 'pull request has' : 'pull requests have'} merge conflicts` },
    sources: { n: failedSources, cls: 'bg-bad text-background' },
  };
  const collapsed = useNavCollapsed();
  const backburners: Partial<Record<View, number>> = { intake: backburner };
  const entry = (v: View) => {
    const { label, icon: Icon } = ITEMS[v];
    const b = badge[v];
    const counted = b && b.n > 0 ? b : undefined;
    return (
      <a key={v} href={`#${v}`} onClick={onPick} aria-current={view === v ? 'page' : undefined}
        className={cn('flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground',
          view === v && 'bg-muted text-foreground')}>
        <Icon className="size-4" />{label}
        {counted && <Count slot="nav-badge" b={counted} />}
        {backburners[v] ? <Backburner slot="nav-badge-backburner" n={backburners[v]} alone={!counted} /> : null}
      </a>
    );
  };
  return (
    <nav className="grid gap-2">
      <div className="grid gap-0.5">{NAV_PINNED.map((v) => entry(v))}</div>
      {NAV_GROUPS.map((g) => {
        const open = !collapsed.includes(g.id);
        const holdsView = (g.views as readonly View[]).includes(view);
        const sum = groupBadges(g.views.map((v) => ({ view: v, label: ITEMS[v].label, badge: badge[v], backburner: backburners[v] })));
        return (
          <div key={g.id} data-nav-group={g.id} className="grid gap-0.5">
            <button type="button" data-slot="nav-group-toggle" aria-expanded={open} data-current={!open && holdsView ? true : undefined} onClick={() => toggleNavGroup(g.id)}
              className={cn('flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/80 transition-colors hover:text-foreground',
                !open && holdsView && 'text-foreground')}>
              <ChevronDown className={cn('size-3.5 transition-transform', !open && '-rotate-90')} aria-hidden />{g.label}
              {!open && sum.badge && <Count slot="nav-group-badge" b={sum.badge} />}
              {!open && sum.backburner && <Backburner slot="nav-group-badge-backburner" n={sum.backburner} alone={!sum.badge} />}
            </button>
            {open && g.views.map((v) => entry(v))}
          </div>
        );
      })}
    </nav>
  );
}

/** A count badge: an entry's, or a collapsed group's sum of them; a high-priority item waiting marks it (issue #535). */
function Count({ slot, b }: { slot: string; b: NavBadge }) {
  return (
    <span data-slot={slot} data-high={b.high ? b.high : undefined} title={b.title}
      className={cn('num ml-auto flex h-5 min-w-5 items-center justify-center gap-0.5 rounded-full px-1.5 text-[11px] font-semibold normal-case tracking-normal', b.cls, b.high && 'ring-2 ring-warn ring-offset-1 ring-offset-background')}>
      {b.high ? <ChevronsUp className="size-3" aria-label="high priority" /> : null}{b.n}
    </span>
  );
}

function Backburner({ slot, n, alone }: { slot: string; n: number; alone: boolean }) {
  return (
    <span data-slot={slot} title={`${n} ${n === 1 ? 'issue' : 'issues'} on the backburner`}
      className={cn('num flex h-5 min-w-5 items-center justify-center gap-0.5 rounded-full border border-dashed px-1.5 text-[11px] font-semibold normal-case tracking-normal text-muted-foreground', alone && 'ml-auto')}>
      <Flame className="size-3" aria-hidden />{n}
    </span>
  );
}

export function Sidebar({ view }: { view: View }) {
  return <aside className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-52 shrink-0 border-r p-3 lg:block"><Links view={view} /></aside>;
}

export function MobileNav({ view }: { view: View }) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild><Button variant="ghost" size="icon-sm" className="lg:hidden" aria-label="Open navigation"><Menu /></Button></SheetTrigger>
      <SheetContent side="left" className="w-64 p-3 pt-12">
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <Links view={view} onPick={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}

export const viewLabel = (v: View) => ITEMS[v].label;
