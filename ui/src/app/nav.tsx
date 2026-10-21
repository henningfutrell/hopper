// The views, routed by URL hash so a link (#questions) and the back button work. A view may have
// sections after a slash (#settings/routing): the view is the part before it. Each section (Questions, Proposals,
// Research, Logins, Failures, Parked; issues #543, #565) is a view whose badge follows the one section rule (useSectionBadges).
// The Jobs view (issue #434) has a card per job. Needs you (issue #897) comes first: its badge counts every decision that waits on a
// person. Intake (issue #897; it was Not taken, issue #798) is badged with the request cards waiting for approval, the labelled issues not assigned to the user (issue #1614) and the jobs a trust stamp holds for a person (issue #655), Access requests
// with what jobs on boxes wait for. Tagged (issue #1141) with the open issues and pull requests that ask for the user's review,
// mention the user or are assigned to the user. An old link (#not-taken) opens the view it became (MOVED). The job view (#job/<id>, issue #433) is a
// route with no nav entry: timeline entries link to it. Infra (issue #896) holds plans, applies and out-of-band changes, and is badged
// with the plans that wait for a person to approve them and the out-of-band changes no one marked (issue #871); Pull requests with the ones the hopper gave up on (issues #897, #927).
// The entries are in nav groups (issue #906, model/nav-groups.ts): a collapsed group shows its entries' badges as one. The Dashboard
// (issue #951; it was the Overview, and #overview still opens it) and Needs you are pinned above them, never collapsed: the Dashboard
// covers the whole system and is the landing page; Needs you's badge already sums other entries', so no group sums it again. Your reports (issue #694) is a view of
// its own (issue #897): it left Settings, which keeps configuration only. Ask hopper (issue #2375; it was Direct jobs, issue #901, and Direct queries, issue #2184, and #direct-jobs and #direct-queries still open it) submits a job with no GitHub issue (Run a job) or asks a question (Ask a question), and reads them back. Resources (issue #947) shows what every
// container of the stack and its Postgres use now. Search (issue #945) finds jobs by their words: the header's search box opens it too.
// Accounts (issue #1128), not under Settings: who each machine's agent tool is signed in as, badged with the machines signed in
// as nobody; in Sources & machines, beside the machines it is about. Skills (issue #1911): the skills jobs get, and the choice
// per kind of work; in Set up, with Settings. Topology (issue #1943) is its own entry in the Infra group, beside Infra: the
// graph and the globe of the services in the AWS accounts and clusters. No group holds one entry only (issue #1943). Pending
// approvals (issue #2088) is its own entry in Waiting on you, badged with the GitHub deployment approvals that wait on the
// person; the header's in-flight badge does not count them.
import { AtSign, BellRing, BookOpen, Search, Briefcase, Bug, ChevronDown, ChevronsUp, CircleDashed, Cpu, FileCheck, FileDiff, Flame, FolderOpen, Gauge, GitPullRequest, Inbox, KeyRound, LayoutDashboard, LayoutGrid, ListOrdered, ListTree, Menu, Network, MessageCircleQuestion, OctagonAlert, Rocket, CirclePause, Scale, Send, Server, Settings, ShieldQuestion, Telescope, UserRound, type LucideIcon } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { useHopper } from '@/store';
import { useAwaitingSort, useSectionBadges } from '@/store/selectors';
import { useNeedsYou } from '@/store/needs-you';
import { useOutOfBand, usePendingApprovals, useToolAccounts } from '@/store/polled';
import { pendingApprovalsBadge } from '@/model/pending-approvals';
import { changesUnmarked } from '@/model/out-of-band';
import { signedOutMachines } from '@/model/tool-accounts';
import { needsYouTotal } from '@/model/needs-you';
import { SECTION_KINDS } from '@/model/sections';
import { notAssignedWaiting, onTheBackburner, requestsWaiting } from '@/model/intake';
import { trustHeldWaiting } from '@/model/trust';
import { groupBadges, type NavBadge } from '@/model/nav-groups';
import { toggleNavGroup, useNavCollapsed } from '@/hooks/use-nav-collapsed';
import { cn } from '@/lib/utils';

export const VIEWS = ['dashboard', 'needs-you', 'search', 'jobs', 'queue', 'ask', 'intake', 'tagged', 'access-requests', 'pending-approvals', ...SECTION_KINDS, 'pull-requests', 'artifacts', 'decisions', 'events', 'reports', 'accounts', 'sources', 'machines', 'infra', 'topology', 'skills', 'usage', 'resources', 'settings'] as const;
/** The routes: every view in the navigation, and the job view, which has no nav entry. */
const ROUTES = [...VIEWS, 'job'] as const;
export type View = (typeof ROUTES)[number];
/** The views above the nav groups, always shown. */
export const NAV_PINNED = ['dashboard', 'needs-you'] as const satisfies readonly (typeof VIEWS)[number][];
/** The nav groups, in nav order, each with its entries in order. A view of the navigation neither pinned nor in a group fails the typecheck. */
export const NAV_GROUPS = [
  { id: 'waiting', label: 'Waiting on you', views: ['intake', 'tagged', 'access-requests', 'pending-approvals', ...SECTION_KINDS] },
  { id: 'jobs', label: 'Jobs', views: ['search', 'jobs', 'queue', 'ask', 'pull-requests', 'artifacts', 'decisions', 'events', 'reports'] },
  { id: 'infra', label: 'Infra', views: ['infra', 'topology'] },
  { id: 'sources-machines', label: 'Sources & machines', views: ['sources', 'machines', 'accounts', 'usage', 'resources'] },
  { id: 'settings', label: 'Set up', views: ['skills', 'settings'] },
] as const satisfies readonly { id: string; label: string; views: readonly (typeof VIEWS)[number][] }[];
const everyViewGrouped: Exclude<(typeof VIEWS)[number], (typeof NAV_GROUPS)[number]['views'][number] | (typeof NAV_PINNED)[number]> extends never ? true : never = true;
void everyViewGrouped;
const ITEMS: Record<View, { label: string; icon: LucideIcon }> = {
  dashboard: { label: 'Dashboard', icon: LayoutDashboard },
  'needs-you': { label: 'Needs you', icon: BellRing },
  search: { label: 'Search', icon: Search },
  jobs: { label: 'Jobs', icon: LayoutGrid },
  queue: { label: 'Queue', icon: ListOrdered },
  ask: { label: 'Ask hopper', icon: Send },
  intake: { label: 'Intake', icon: CircleDashed },
  tagged: { label: 'Tagged', icon: AtSign },
  'access-requests': { label: 'Access requests', icon: ShieldQuestion },
  'pending-approvals': { label: 'Pending approvals', icon: Rocket },
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
  reports: { label: 'Your reports', icon: Bug },
  accounts: { label: 'Accounts', icon: UserRound },
  sources: { label: 'Sources', icon: Inbox },
  machines: { label: 'Machines', icon: Server },
  infra: { label: 'Infra', icon: FileDiff },
  topology: { label: 'Topology', icon: Network },
  skills: { label: 'Skills', icon: BookOpen },
  usage: { label: 'Usage', icon: Gauge },
  resources: { label: 'Resources', icon: Cpu },
  settings: { label: 'Settings', icon: Settings },
  job: { label: 'Job', icon: Briefcase },
};

const subscribe = (fn: () => void) => { window.addEventListener('hashchange', fn); return () => window.removeEventListener('hashchange', fn); };
/** Old view names and the view each became, with the section it opens when it is one, so an old link still opens it. */
const MOVED: Record<string, { view: View; section?: string }> = {
  'not-taken': { view: 'intake' }, overview: { view: 'dashboard' }, 'direct-jobs': { view: 'ask' }, 'direct-queries': { view: 'ask', section: 'question' },
};
const read = (): View => { const h = window.location.hash.slice(1).split('/')[0]!; return MOVED[h]?.view ?? ((ROUTES as readonly string[]).includes(h) ? (h as View) : 'dashboard'); };
export const useView = (): View => useSyncExternalStore(subscribe, read);
/** The section after the view in the hash (#settings/routing → routing), or ''; an old view name's own section when it moved into one. */
const readSection = (): string => { const [h, section] = window.location.hash.slice(1).split('/'); return MOVED[h!]?.section ?? section ?? ''; };
export const useSection = (): string => useSyncExternalStore(subscribe, readSection);

function Links({ view, onPick }: { view: View; onPick?: () => void }) {
  const failedSources = useHopper((s) => s.sources.filter((x) => x.state === 'error').length);
  const requests = useHopper((s) => requestsWaiting(s.sources));
  const unassigned = useHopper((s) => notAssignedWaiting(s.sources));
  const trustHeld = useHopper((s) => trustHeldWaiting(s.jobs));
  const backburner = useHopper((s) => onTheBackburner(s.sources));
  const sorting = useAwaitingSort();
  // Every section's badge by the one rule; a high-priority item waiting (issue #535) marks it and says how many.
  const sections = useSectionBadges();
  const rows = useNeedsYou();
  const total = needsYouTotal(rows);
  const n = (k: (typeof rows)[number]['kind']): number => rows.find((r) => r.kind === k)!.n;
  const access = n('access');
  // Issue #2196: the templates and sandbox runs a high-priority job waits on mark the entry, as in Needs you.
  const highOf = (k: (typeof rows)[number]['kind']): number => rows.find((r) => r.kind === k)!.high;
  const plans = n('plans');
  const unmarked = changesUnmarked(useOutOfBand());
  const gaveUp = n('pull-requests');
  const unread = n('checks');
  const tagged = n('tagged');
  const signedOut = signedOutMachines(useToolAccounts()?.accounts ?? []);
  const approvals = pendingApprovalsBadge(usePendingApprovals());
  const badge: Partial<Record<View, NavBadge>> = {
    queue: { n: sorting, cls: 'bg-warn text-background', title: `${sorting} ${sorting === 1 ? 'job' : 'jobs'} waiting to be ordered` },
    'needs-you': { n: total.n, high: total.high, cls: 'bg-warn text-background', title: `${total.n} ${total.n === 1 ? 'decision waits' : 'decisions wait'} on you` },
    intake: { n: requests + unassigned + trustHeld, cls: 'bg-warn text-background', title: [
      requests > 0 && `${requests} ${requests === 1 ? 'request waits' : 'requests wait'} for approval`,
      unassigned > 0 && `${unassigned} labelled ${unassigned === 1 ? 'issue waits' : 'issues wait'} to be assigned to you`,
      trustHeld > 0 && `${trustHeld} ${trustHeld === 1 ? 'job held by its' : 'jobs held by their'} trust stamp`,
    ].filter(Boolean).join('; ') },
    tagged: { n: tagged, cls: 'bg-warn text-background', title: `${tagged} ${tagged === 1 ? 'item asks' : 'items ask'} for your review, mention you or are assigned to you` },
    'access-requests': { n: access, high: highOf('access'), cls: 'bg-warn text-background', title: `${access} ${access === 1 ? 'access request waits' : 'access requests wait'} on you` },
    'pending-approvals': approvals,
    ...sections,
    infra: { n: plans + unmarked, cls: 'bg-warn text-background', title: [plans > 0 && `${plans} ${plans === 1 ? 'plan waits' : 'plans wait'} for a person to approve`, unmarked > 0 && `${unmarked} out-of-band ${unmarked === 1 ? 'change waits' : 'changes wait'} to be marked`].filter(Boolean).join('; ') },
    'pull-requests': { n: gaveUp + unread, cls: 'bg-bad text-background', title: [
      gaveUp > 0 && `the hopper gave up on ${gaveUp} ${gaveUp === 1 ? 'pull request' : 'pull requests'}`,
      unread > 0 && `the hopper cannot read the checks of ${unread} ${unread === 1 ? 'repository' : 'repositories'}`,
    ].filter(Boolean).join('; ') },
    accounts: { n: signedOut, cls: 'bg-bad text-background', title: `${signedOut} ${signedOut === 1 ? 'machine is' : 'machines are'} signed in as nobody` },
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
    <span data-slot={slot} title={`${n} ${n === 1 ? 'issue' : 'issues'} for later (on the backburner: the hopper:backburner label)`}
      className={cn('num flex h-5 min-w-5 items-center justify-center gap-0.5 rounded-full border border-dashed px-1.5 text-[11px] font-semibold normal-case tracking-normal text-muted-foreground', alone && 'ml-auto')}>
      <Flame className="size-3" aria-hidden />{n}
    </span>
  );
}

export function Sidebar({ view }: { view: View }) {
  return <aside className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-52 shrink-0 overflow-y-auto overscroll-contain border-r p-3 lg:block"><Links view={view} /></aside>;
}

export function MobileNav({ view }: { view: View }) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild><Button variant="ghost" size="icon-sm" className="lg:hidden" aria-label="Open navigation"><Menu /></Button></SheetTrigger>
      {/* The drawer is the screen's height and its list scrolls on its own (issue #905): a phone shows fewer entries
          than there are. The close button stays above the list; the list's end stays clear of the bottom safe area. */}
      <SheetContent side="left" className="max-h-dvh w-64 gap-0 p-0 pt-12">
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <div data-slot="nav-scroll" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <Links view={view} onPick={() => setOpen(false)} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

export const viewLabel = (v: View) => ITEMS[v].label;
