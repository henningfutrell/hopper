// The page: nothing until the session is read, then the landing page logged out (issue #213), or the
// shell — header, navigation, the current view — signed in. Loads once, then lives on SSE. Another hopper at this
// address (issue #1295): its notice alone, in place of all of it. The critical job tracker (issue #2203) sits over every
// view, so it stays through navigation.
import { AlertTriangle } from 'lucide-react';
import { useEffect } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { Toaster } from '@/components/ui/sonner';
import { useForgetCleared } from '@/hooks/use-dismissed';
import { TooltipProvider } from '@/components/ui/tooltip';
import { load, mustSignIn, recheckSession, SESSION_CHECK_MS, setLoadError, useHopper } from '@/store';
import { connect } from '@/store/stream';
import { AccessRequests } from '@/views/access-requests';
import { Tagged } from '@/views/tagged';
import { Artifacts } from '@/views/artifacts';
import { BugReports } from '@/views/bug-reports';
import { Decisions } from '@/views/decisions';
import { AskHopper } from '@/views/ask';
import { Events } from '@/views/events';
import { Failures } from '@/views/failures';
import { Infra } from '@/views/infra';
import { Topology } from '@/views/topology-page'; import { PendingApprovals } from '@/views/pending-approvals';
import { Skills } from '@/views/skills';
import { JobView } from '@/views/job';
import { Jobs } from '@/views/jobs';
import { Intake } from '@/views/intake';
import { Logins } from '@/views/logins';
import { Machines } from '@/views/machines';
import { NeedsYou } from '@/views/needs-you';
import { Dashboard } from '@/views/dashboard';
import { Parked } from '@/views/parked';
import { PullRequests } from '@/views/pull-requests';
import { Proposals, Research } from '@/views/review-section';
import { Questions } from '@/views/questions';
import { Resources } from '@/views/resources';
import { Search } from '@/views/search';
import { Queue } from '@/views/queue';
import { Settings } from '@/views/settings';
import { Sources } from '@/views/sources';
import { Usage } from '@/views/usage';
import { Accounts } from '@/views/accounts';
import { CriticalTracker } from './critical-tracker';
import { Header } from './header';
import { Landing } from './landing';
import { StackNotices } from './drift';
import { MasterKeyNotice } from './master-key';
import { HopperGate } from './other-hopper';
import { WindowsLinkNotice } from '@/components/windows-link';
import { UpdateNotice } from './update';
import { MobileNav, Sidebar, useView, viewLabel, type View } from './nav';

const VIEW: Record<View, () => React.ReactNode> = {
  'needs-you': NeedsYou, dashboard: Dashboard, search: Search, jobs: Jobs, queue: Queue, ask: AskHopper, intake: Intake, tagged: Tagged, 'access-requests': AccessRequests, 'pending-approvals': PendingApprovals, questions: Questions, proposals: Proposals, research: Research, logins: Logins, failures: Failures, parked: Parked, 'pull-requests': PullRequests, artifacts: Artifacts, decisions: Decisions, events: Events, reports: BugReports, accounts: Accounts, sources: Sources, machines: Machines, infra: Infra, topology: Topology, skills: Skills, usage: Usage, resources: Resources, settings: Settings, job: JobView,
};

function Loading() {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-28" />)}</div>
      <Skeleton className="h-64" />
    </div>
  );
}

function Shell() {
  const view = useView();
  const loaded = useHopper((s) => s.loaded);
  const loadError = useHopper((s) => s.loadError);
  useForgetCleared();
  useEffect(() => { document.title = view === 'dashboard' ? 'hopper' : `${viewLabel(view)} · hopper`; }, [view]);
  const Current = VIEW[view];
  return (
    <div className="min-h-dvh">
      <Header nav={<MobileNav view={view} />} />
      <div className="flex">
        <Sidebar view={view} />
        <main className="min-w-0 flex-1 space-y-3 p-3 sm:p-4 lg:p-6">
          <MasterKeyNotice />
          <StackNotices />
          <WindowsLinkNotice />
          <UpdateNotice />
          {loaded && <CriticalTracker />}
          {loadError && (
            <div className="flex items-center gap-2 rounded-lg border border-bad/40 bg-bad/5 p-3 text-sm text-bad">
              <AlertTriangle className="size-4" />Could not load from the daemon: {loadError}
            </div>
          )}
          {loaded ? <Current /> : !loadError && <Loading />}
        </main>
      </div>
    </div>
  );
}

export function App() {
  const sessionRead = useHopper((s) => s.sessionRead);
  const signInFirst = useHopper(mustSignIn);
  useEffect(() => {
    let close: (() => void) | undefined;
    let cancelled = false;
    load().then((ok) => { if (ok && !cancelled) close = connect(); }, (e: Error) => setLoadError(e.message));
    return () => { cancelled = true; close?.(); };
  }, []);
  // A session can end while the page is open (issue #439): ask now and then, and when the page is looked at again.
  const authed = useHopper((s) => s.authed);
  useEffect(() => {
    if (!authed) return;
    const check = () => { if (document.visibilityState === 'visible') void recheckSession(); };
    const timer = setInterval(check, SESSION_CHECK_MS);
    document.addEventListener('visibilitychange', check);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', check); };
  }, [authed]);
  return (
    <HopperGate>
      {/* Nothing until the session is read: no flash of the app before the landing page. */}
      {sessionRead && (
        <TooltipProvider delayDuration={300}>
          {signInFirst ? <Landing /> : <Shell />}
          <Toaster position="bottom-right" closeButton />
        </TooltipProvider>
      )}
    </HopperGate>
  );
}
