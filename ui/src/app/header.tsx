// The top bar: version (opens the version and update panel, on every screen), connection,
// router health, uptime, the API reference, and the user menu: who you are, the theme, the device link and Sign out
// behind one button at every width (issue #666). Shown only signed in (issue #213).
// A GitHub connection that ended asks to connect again here, on every screen (issue #441) — unless the person signed in
// with GitHub: then the session ended with it, and the page asks the daemon at once and goes to sign-in (issue #513). Pending logins are
// counted here on every screen, warning when one expires soon, a link to the Logins view (issue #477).
// On a phone the wordmark and the API reference give way, so the version badge with its channel, the connection dot and
// the user menu are all the bar holds (issues #497, #666).
import { BookOpen, KeyRound } from 'lucide-react';
import { useEffect } from 'react';
import logo from '../../../site/hopper-logo.svg';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Dot, StatusBadge } from '@/components/status';
import { duration } from '@/model/format';
import { connectionEnded } from '@/model/sources';
import { recheckSession, useHopper } from '@/store';
import { cn } from '@/lib/utils';
import { useLoginsBadge, useSignedInWith } from '@/store/selectors';
import { UpdateButton } from './update';
import { UserMenu } from './user-menu';

export function Header({ nav }: { nav?: React.ReactNode }) {
  const health = useHopper((s) => s.health);
  const conn = useHopper((s) => s.conn);
  const ended = useHopper((s) => connectionEnded(s.sources));
  const signedInWithGitHub = useSignedInWith('github');
  // Signed in with GitHub, the session ended with the connection (issue #513): no reconnect here, straight to sign-in.
  useEffect(() => { if (ended && signedInWithGitHub) void recheckSession(); }, [ended, signedInWithGitHub]);
  const logins = useLoginsBadge();
  return (
    <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur-md">
      <div className="flex h-14 items-center gap-2 px-3 sm:gap-3 sm:px-4 lg:px-6">
        {nav}
        <div className="flex items-center gap-2 font-semibold tracking-tight">
          <img src={logo} alt="" className="h-7 w-auto" />
          <span className="max-sm:sr-only">hopper</span>
        </div>
        <UpdateButton version={health?.version} />
        <div className="ml-auto flex items-center gap-1 text-xs sm:gap-3">
          {ended && !signedInWithGitHub && (
            <a data-connection-ended href="#sources" title={ended}
              className="rounded-md border border-bad/30 bg-bad/5 px-2 py-1 font-medium text-bad hover:bg-bad/10">GitHub: reconnect needed</a>
          )}
          {logins.n > 0 && (
            <a data-logins-pending href="#logins" title={logins.warn ? 'A login expires soon' : 'Logins wait on you'}
              className={cn('flex items-center gap-1.5 rounded-md border px-2 py-1 font-medium',
                logins.warn ? 'border-warn/40 bg-warn/10 text-warn hover:bg-warn/15' : 'border-border text-foreground hover:bg-muted/60')}>
              <KeyRound className="size-3.5" /><span className="num">{logins.n}</span> <span className="max-sm:sr-only">{logins.n === 1 ? 'login' : 'logins'} pending</span>
            </a>
          )}
          <div className="hidden items-center gap-1.5 md:flex">
            <span className="text-muted-foreground">router</span>
            <span className="font-mono">{health?.router ?? '…'}</span>
            {health?.fallback && <StatusBadge status="fallback" tone="warn" />}
          </div>
          <span className="num hidden text-muted-foreground sm:inline">up {health ? duration(health.uptimeS) : '…'}</span>
          <span data-slot="connection" className="flex items-center gap-1.5 text-muted-foreground">
            <Dot tone={conn === 'live' ? 'ok' : 'warn'} pulse={conn === 'live'} /><span className="hidden sm:inline">{conn}</span>
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="max-sm:hidden" asChild>
                <a href="/docs/" target="_blank" rel="noopener" aria-label="API reference"><BookOpen /></a>
              </Button>
            </TooltipTrigger>
            <TooltipContent>API reference</TooltipContent>
          </Tooltip>
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
