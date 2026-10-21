// The navigation: every view's entry and badge (the routes are routes.ts). Needs you (issue #897) comes first: its badge counts
// every decision that waits on a person; it owns no workflow, its rows link to their homes. Each section (issue #543) is an
// entry or a merged page's tab, and its badge follows the one section rule (useSectionBadges). Intake (issue #897) is badged
// with the request cards waiting for approval, the labelled issues not assigned to the user (issue #1614) and the jobs a
// trust stamp holds for a person (issue #655); Tagged (issue #1141) with the open issues and pull requests that ask for the
// user's review, mention the user or are assigned to the user; Infra (issue #896) with the plans that wait for a person and
// the out-of-band changes no one marked (issue #871); Pull requests with the ones the hopper gave up on (issues #897, #927).
// The entries are in nav groups (issue #906, model/nav-groups.ts): a collapsed group shows its entries' badges as one, and no
// group holds one entry only (issue #1943). The Dashboard (issue #951) and Needs you are pinned above them, never collapsed:
// the Dashboard covers the whole system and is the landing page; Needs you's badge already sums other entries', so no group
// sums it again. One canonical home per workflow (issue #2374): Approvals holds Access requests (what jobs on boxes wait
// for) and Pending approvals (GitHub deployment approvals, issue #2088); Failures holds Stuck work and Parked (issue #565);
// Jobs holds the Queue order; Ask hopper (issue #2375) holds Run a job (Direct jobs, issue #901) and Ask a question (Direct queries, issue #2184); Activity holds
// Events and Decisions; Machines holds Accounts (issue #1128) and Logins; Usage holds Resources (issue #947). A merged
// page's entry badge sums its tabs', each tab showing its own (page-tabs.tsx). Search (issue #945) has no entry in the
// sidebar: the header's search box opens it; on a phone, which has no search box, the drawer lists it after Needs you.
// Your reports (issue #694) and Version history are in the user menu. Plugins, Vault and Users & access (issue #2373) left
// Settings for entries of their own: Vault in Infra, Plugins and Users & access in Admin; their old Settings hashes open them.
import { AtSign, BellRing, BookOpen, Search, Briefcase, Bug, ChevronDown, ChevronsUp, CircleDashed, FileCheck, FileDiff, Flame, FolderOpen, Gauge, GitPullRequest, Inbox, LayoutDashboard, LockKeyhole, LayoutGrid, ListTree, Menu, Network, MessageCircleQuestion, OctagonAlert, Puzzle, Send, Server, Settings, ShieldQuestion, Telescope, Users, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
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
import { notAssignedWaiting, onTheBackburner, requestsWaiting } from '@/model/intake';
import { trustHeldWaiting } from '@/model/trust';
import { groupBadges, mergedBadge, type NavBadge } from '@/model/nav-groups';
import { toggleNavGroup, useNavCollapsed } from '@/hooks/use-nav-collapsed';
import { cn } from '@/lib/utils';

import { NAV_GROUPS, NAV_PINNED, PAGE_TABS, type MergedPage, type Tab, type View } from './routes';

export { NAV_GROUPS, NAV_PINNED, PAGE_TABS, VIEWS, useSection, useView, type View } from './routes';
const ITEMS: Record<View, { label: string; icon: LucideIcon }> = {
  dashboard: { label: 'Dashboard', icon: LayoutDashboard },
  'needs-you': { label: 'Needs you', icon: BellRing },
  search: { label: 'Search', icon: Search },
  jobs: { label: 'Jobs', icon: LayoutGrid },
  ask: { label: 'Ask hopper', icon: Send },
  intake: { label: 'Intake', icon: CircleDashed },
  tagged: { label: 'Tagged', icon: AtSign },
  approvals: { label: 'Approvals', icon: ShieldQuestion },
  questions: { label: 'Questions', icon: MessageCircleQuestion },
  proposals: { label: 'Proposals', icon: FileCheck },
  research: { label: 'Research', icon: Telescope },
  failures: { label: 'Failures', icon: OctagonAlert },
  'pull-requests': { label: 'Pull requests', icon: GitPullRequest },
  artifacts: { label: 'Artifacts', icon: FolderOpen },
  activity: { label: 'Activity', icon: ListTree },
  reports: { label: 'Your reports', icon: Bug },
  sources: { label: 'Sources', icon: Inbox },
  machines: { label: 'Machines', icon: Server },
  infra: { label: 'Infra', icon: FileDiff },
  topology: { label: 'Topology', icon: Network },
  skills: { label: 'Skills', icon: BookOpen },
  plugins: { label: 'Plugins', icon: Puzzle },
  vault: { label: 'Vault', icon: LockKeyhole },
  'users-access': { label: 'Users & access', icon: Users },
  usage: { label: 'Usage', icon: Gauge },
  settings: { label: 'Settings', icon: Settings },
  job: { label: 'Job', icon: Briefcase },
};

/** Every badge: each nav entry's, and each merged page's tab's (issue #2374). A merged page's entry sums its tabs'. */
export function useNavBadges(): { entries: Partial<Record<View, NavBadge>>; tabs: Partial<Record<Tab, NavBadge>> } {
  const failedSources = useHopper((s) => s.sources.filter((x) => x.state === 'error').length);
  const requests = useHopper((s) => requestsWaiting(s.sources));
  const unassigned = useHopper((s) => notAssignedWaiting(s.sources));
  const trustHeld = useHopper((s) => trustHeldWaiting(s.jobs));
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
  const badge: Partial<Record<View | Tab, NavBadge>> = {
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
  const merged = Object.fromEntries((Object.keys(PAGE_TABS) as MergedPage[]).map((p) => [p, mergedBadge(PAGE_TABS[p].map((t) => badge[t.id]))]));
  return { entries: { ...badge, ...merged }, tabs: badge };
}

function Links({ view, onPick, phone }: { view: View; onPick?: () => void; phone?: boolean }) {
  const backburner = useHopper((s) => onTheBackburner(s.sources));
  const badge = useNavBadges().entries;
  const collapsed = useNavCollapsed();
  const backburners: Partial<Record<View, number>> = { intake: backburner };
  const entry = (v: View) => {
    const { label, icon: Icon } = ITEMS[v];
    const b = badge[v];
    const counted = b && b.n > 0 ? b : undefined;
    return (
      <a key={v} href={`#${v}`} onClick={onPick} aria-current={view === v ? 'page' : undefined}
        className={cn('flex items-center gap-2.5 rounded-md px-2.5 text-sm', phone ? 'h-9' : 'h-7', 'text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground',
          view === v && 'bg-muted text-foreground')}>
        <Icon className="size-4" />{label}
        {counted && <Count slot="nav-badge" b={counted} />}
        {backburners[v] ? <Backburner slot="nav-badge-backburner" n={backburners[v]} alone={!counted} /> : null}
      </a>
    );
  };
  return (
    <nav className="grid gap-0.5">
      <div className="grid gap-px">{NAV_PINNED.map((v) => entry(v))}{phone && entry('search')}</div>
      {NAV_GROUPS.map((g) => {
        const open = !collapsed.includes(g.id);
        const holdsView = (g.views as readonly View[]).includes(view);
        const sum = groupBadges(g.views.map((v) => ({ view: v, label: ITEMS[v].label, badge: badge[v], backburner: backburners[v] })));
        return (
          <div key={g.id} data-nav-group={g.id} className="grid gap-px">
            <button type="button" data-slot="nav-group-toggle" aria-expanded={open} data-current={!open && holdsView ? true : undefined} onClick={() => toggleNavGroup(g.id)}
              className={cn('flex h-5.5 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/80 transition-colors hover:text-foreground',
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
export function Count({ slot, b }: { slot: string; b: NavBadge }) {
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
  return <aside className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-52 shrink-0 overflow-y-auto overscroll-contain border-r px-3 py-2 lg:block"><Links view={view} /></aside>;
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
          <Links view={view} onPick={() => setOpen(false)} phone />
        </div>
      </SheetContent>
    </Sheet>
  );
}

export const viewLabel = (v: View) => ITEMS[v].label;
