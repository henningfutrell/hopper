// The views, routed by URL hash so a link (#questions) and the back button work. A view may have
// sections after a slash (#settings/routing): the view is the part before it. Each section (Questions, Proposals,
// Research, Logins, Failures, Parked; issues #543, #565) is a view whose badge follows the one section rule (useSectionBadges).
// The Jobs view (issue #434) has a card per job. Needs you (issue #897) comes first: its badge counts every decision that waits on a
// person. Intake (issue #897; it was Not taken, issue #798) is badged with the request cards waiting for approval, Access requests
// with what jobs on boxes wait for. An old link (#not-taken) opens the view it became (MOVED). The job view (#job/<id>, issue #433) is a
// route with no nav entry: timeline entries link to it. Infra (issue #896) holds plans, applies and out-of-band changes.
import { BellRing, Briefcase, ChevronsUp, CircleDashed, FileCheck, FileDiff, Flame, FolderOpen, Gauge, GitPullRequest, Inbox, KeyRound, LayoutDashboard, LayoutGrid, ListOrdered, ListTree, Menu, MessageCircleQuestion, OctagonAlert, CirclePause, Scale, Server, Settings, ShieldQuestion, Telescope, type LucideIcon } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { useHopper } from '@/store';
import { useAwaitingSort, useSectionBadges } from '@/store/selectors';
import { useNeedsYou } from '@/store/needs-you';
import { needsYouTotal } from '@/model/needs-you';
import { SECTION_KINDS } from '@/model/sections';
import { onTheBackburner, requestsWaiting } from '@/model/intake';
import { cn } from '@/lib/utils';

export const VIEWS = ['needs-you', 'overview', 'jobs', 'queue', 'intake', 'access-requests', ...SECTION_KINDS, 'pull-requests', 'artifacts', 'decisions', 'events', 'sources', 'machines', 'infra', 'usage', 'settings'] as const;
/** The routes: every view in the navigation, and the job view, which has no nav entry. */
const ROUTES = [...VIEWS, 'job'] as const;
export type View = (typeof ROUTES)[number];
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
  const access = rows.find((r) => r.kind === 'access')!.n;
  const badge: Partial<Record<View, { n: number; cls: string; title?: string; high?: number }>> = {
    queue: { n: sorting, cls: 'bg-warn text-background', title: `${sorting} ${sorting === 1 ? 'job waits' : 'jobs wait'} on the pre-sort` },
    'needs-you': { n: total.n, high: total.high, cls: 'bg-warn text-background', title: `${total.n} ${total.n === 1 ? 'decision waits' : 'decisions wait'} on you` },
    intake: { n: requests, cls: 'bg-warn text-background', title: `${requests} ${requests === 1 ? 'request waits' : 'requests wait'} for approval` },
    'access-requests': { n: access, cls: 'bg-warn text-background', title: `${access} ${access === 1 ? 'access request waits' : 'access requests wait'} on you` },
    ...sections,
    sources: { n: failedSources, cls: 'bg-bad text-background' },
  };
  return (
    <nav className="grid gap-0.5">
      {VIEWS.map((v) => {
        const { label, icon: Icon } = ITEMS[v];
        const b = badge[v];
        return (
          <a key={v} href={`#${v}`} onClick={onPick} aria-current={view === v ? 'page' : undefined}
            className={cn('flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground',
              view === v && 'bg-muted text-foreground')}>
            <Icon className="size-4" />{label}
            {b && b.n > 0 && (
              <span data-slot="nav-badge" data-high={b.high ? b.high : undefined} title={b.title}
                className={cn('num ml-auto flex h-5 min-w-5 items-center justify-center gap-0.5 rounded-full px-1.5 text-[11px] font-semibold', b.cls, b.high && 'ring-2 ring-warn ring-offset-1 ring-offset-background')}>
                {b.high ? <ChevronsUp className="size-3" aria-label="high priority" /> : null}{b.n}
              </span>
            )}
            {v === 'intake' && backburner > 0 && (
              <span data-slot="nav-badge-backburner" title={`${backburner} ${backburner === 1 ? 'issue' : 'issues'} on the backburner`}
                className={cn('num flex h-5 min-w-5 items-center justify-center gap-0.5 rounded-full border border-dashed px-1.5 text-[11px] font-semibold text-muted-foreground', !(b && b.n > 0) && 'ml-auto')}>
                <Flame className="size-3" aria-hidden />{backburner}
              </span>
            )}
          </a>
        );
      })}
    </nav>
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
