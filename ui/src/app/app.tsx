// The shell: header, navigation, the current view. Loads once, then lives on SSE.
import { AlertTriangle } from 'lucide-react';
import { useEffect } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { Toaster } from '@/components/ui/sonner';
import { useForgetCleared } from '@/hooks/use-dismissed';
import { TooltipProvider } from '@/components/ui/tooltip';
import { load, mustSignIn, setLoadError, useHopper } from '@/store';
import { connect } from '@/store/stream';
import { Decisions } from '@/views/decisions';
import { Events } from '@/views/events';
import { Machines } from '@/views/machines';
import { Overview } from '@/views/overview';
import { Questions } from '@/views/questions';
import { Settings } from '@/views/settings';
import { Sources } from '@/views/sources';
import { Usage } from '@/views/usage';
import { ReadOnlyBanner, SignInRequired } from './banner';
import { Header } from './header';
import { UpdateNotice } from './update';
import { MobileNav, Sidebar, useView, viewLabel, type View } from './nav';

const VIEW: Record<View, () => React.ReactNode> = {
  overview: Overview, questions: Questions, decisions: Decisions, events: Events, sources: Sources, machines: Machines, usage: Usage, settings: Settings,
};

function Loading() {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-28" />)}</div>
      <Skeleton className="h-64" />
    </div>
  );
}

export function App() {
  const view = useView();
  const loaded = useHopper((s) => s.loaded);
  const loadError = useHopper((s) => s.loadError);
  const signInFirst = useHopper(mustSignIn);
  useForgetCleared();
  useEffect(() => {
    let close: (() => void) | undefined;
    let cancelled = false;
    load().then((ok) => { if (ok && !cancelled) close = connect(); }, (e: Error) => setLoadError(e.message));
    return () => { cancelled = true; close?.(); };
  }, []);
  useEffect(() => { document.title = view === 'overview' ? 'hopper' : `${viewLabel(view)} · hopper`; }, [view]);
  const Current = VIEW[view];
  return (
    <TooltipProvider delayDuration={300}>
      <div className="min-h-dvh">
        <Header nav={<MobileNav view={view} />} />
        <div className="flex">
          <Sidebar view={view} />
          <main className="min-w-0 flex-1 space-y-3 p-3 sm:p-4 lg:p-6">
            {signInFirst ? <SignInRequired /> : <ReadOnlyBanner />}
            <UpdateNotice />
            {loadError && (
              <div className="flex items-center gap-2 rounded-lg border border-bad/40 bg-bad/5 p-3 text-sm text-bad">
                <AlertTriangle className="size-4" />Could not load from the daemon: {loadError}
              </div>
            )}
            {signInFirst ? null : loaded ? <Current /> : !loadError && <Loading />}
          </main>
        </div>
      </div>
      <Toaster position="bottom-right" closeButton />
    </TooltipProvider>
  );
}
