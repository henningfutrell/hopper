// The top bar: version (opens the version and update panel, on every screen), connection,
// router health, uptime, the help pages (issue #782), the API reference, and the user menu: who you are, the theme, the device link and Sign out
// behind one button at every width (issue #666). Shown only signed in (issue #213).
// A GitHub connection that ended asks to connect again here, on every screen (issue #441), whatever the person signed in
// with: the connection is a source, and its end ends no session (issue #1380). Pending logins are
// counted here on every screen, warning when one expires soon, a link to the Logins view (issue #477). Yolo mode shows here
// on every screen (issue #897): off, on, or on in some repositories, a link to its one switch in Settings → Yolo mode.
// A stall of the hopper's event loop shows here for 10 minutes, a warning with how long it was and the routes in flight (issue #1002).
// The header badges (issue #1181) show here on every screen: the Dashboard's KPI cards the user chose in Customize, each its
// card's own total (`useKpis`), so a badge and its card never disagree; one Lanes badge until chosen. In flight (issue #1113)
// is the work-item ledger's count, a link to the Jobs view filtered to them; the others link to the Dashboard.
// File an issue (issue #471, file-issue.tsx) is a button here on every screen from tablet width up (a phone has it in the
// user menu): an operator's or admin's, off with the reason while no provider can draft.
// The search box (issue #945, search-box.tsx) finds jobs from every screen at tablet width and up; a phone uses the Search entry.
// On a phone the wordmark, the help link and the API reference give way (Help stays in the user menu), so the version badge with its channel, the connection dot and
// the user menu are all the bar holds (issues #497, #666).
import { Activity, BookOpen, CircleCheck, CircleHelp, CircleX, KeyRound, Layers, MessageCircleQuestion, Timer, Zap } from 'lucide-react';
import logo from '../../../site/hopper-logo.svg';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Dot, StatusBadge } from '@/components/status';
import { duration } from '@/model/format';
import { IN_FLIGHT_SECTION } from '@/model/jobs-view';
import { inFlightParts } from '@/model/in-flight';
import { BADGES, shownBadges } from '@/model/header-badges';
import type { HeaderBadge, Health } from '@/model/wire';
import { connectionEnded } from '@/model/sources';
import { yoloIndicator } from '@/model/yolo-mode';
import { useHopper } from '@/store';
import { cn } from '@/lib/utils';
import { useHeaderBadges, useYoloMode } from '@/store/polled';
import { useKpis, useLoginsBadge } from '@/store/selectors';
import { FileIssueButton } from './file-issue';
import { SearchBox } from './search-box';
import { UpdateButton } from './update';
import { UserMenu } from './user-menu';

/** What a stall of the event loop was (issue #1002): how long, when, the routes in flight, the database's part (issue #1154), and the code it ran (issue #1383). */
const stallTitle = (s: NonNullable<Health['eventLoopStall']>): string =>
  `The hopper stopped answering for ${(s.ms / 1000).toFixed(1)} s at ${new Date(s.at).toLocaleTimeString()}${s.during.length ? `, during ${s.during.join(', ')}` : ''}.`
  + `${s.store ? ` The database held it for ${(s.store.ms / 1000).toFixed(1)} s (${s.store.calls.map((c) => c.what).join(', ')}).` : ''}`
  + `${s.held?.[0]?.frames[0] ? ` It ran ${s.held[0].frames[0]}.` : ''} Its log says more.`;

const BADGE_ICONS: Record<HeaderBadge, typeof Activity> = {
  inFlight: Activity, lanes: Layers, waiting: Timer, waitingAnswer: MessageCircleQuestion, finished: CircleCheck, failed: CircleX,
};

/** The header badges the user chose (issue #1181), each its card's total. */
function HeaderBadges() {
  const shown = shownBadges(useHeaderBadges());
  const { k, totals } = useKpis();
  const inFlight = useHopper((s) => s.inFlight);
  // No badge before the queue is read (issue #1113): a count of nothing read yet is no 0.
  if (inFlight === null) return null;
  return shown.map((b) => {
    const Icon = BADGE_ICONS[b];
    const n = totals[b];
    const title = b === 'inFlight' ? `${n} in flight: ${inFlightParts(inFlight)}`
      : b === 'lanes' ? `${n} of ${k.lanesMax} lanes in use${k.lanesOver ? `, ${k.lanesOver} over the cap` : ''}`
        : `${BADGES[b].title}: ${n}`;
    return (
      <a key={b} data-slot={b === 'inFlight' ? 'in-flight' : 'header-badge'} data-badge={b} href={b === 'inFlight' ? `#jobs/${IN_FLIGHT_SECTION}` : '#dashboard'} title={title}
        className={cn('flex items-center gap-1.5 rounded-md border px-2 py-1 font-medium hover:bg-muted/60', n > 0 ? 'border-busy/40 text-busy' : 'border-border text-muted-foreground')}>
        <Icon className="size-3.5" aria-hidden /><span className="num">{n}</span> <span className="max-sm:sr-only">{BADGES[b].words(n)}</span>
      </a>
    );
  });
}

export function Header({ nav }: { nav?: React.ReactNode }) {
  const health = useHopper((s) => s.health);
  const conn = useHopper((s) => s.conn);
  const ended = useHopper((s) => connectionEnded(s.sources));
  const logins = useLoginsBadge();
  const yolo = yoloIndicator(useYoloMode());
  return (
    <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur-md">
      <div className="flex h-14 items-center gap-2 px-3 sm:gap-3 sm:px-4 lg:px-6">
        {nav}
        <div className="flex items-center gap-2 font-semibold tracking-tight">
          <img src={logo} alt="" className="h-7 w-auto" />
          <span className="max-sm:sr-only">hopper</span>
        </div>
        <UpdateButton version={health?.version} />
        <div className="hidden min-w-0 flex-1 justify-center md:flex"><SearchBox /></div>
        <div className="ml-auto flex items-center gap-1 text-xs sm:gap-3">
          {ended && (
            <a data-connection-ended href="#sources" title={ended}
              className="rounded-md border border-bad/30 bg-bad/5 px-2 py-1 font-medium text-bad hover:bg-bad/10">GitHub: reconnect needed</a>
          )}
          <HeaderBadges />
          {logins.n > 0 && (
            <a data-logins-pending href="#machines/logins" title={logins.warn ? 'A login expires soon' : 'Logins wait on you'}
              className={cn('flex items-center gap-1.5 rounded-md border px-2 py-1 font-medium',
                logins.warn ? 'border-warn/40 bg-warn/10 text-warn hover:bg-warn/15' : 'border-border text-foreground hover:bg-muted/60')}>
              <KeyRound className="size-3.5" /><span className="num">{logins.n}</span> <span className="max-sm:sr-only">{logins.n === 1 ? 'login' : 'logins'} pending</span>
            </a>
          )}
          {yolo && (
            <a data-yolo={yolo.on ? 'on' : 'off'} href="#settings/yolo-mode" title={yolo.title}
              className={cn('flex items-center gap-1 rounded-md border px-2 py-1 font-medium',
                yolo.on ? 'border-warn/40 bg-warn/10 text-warn hover:bg-warn/15' : 'border-border text-muted-foreground hover:bg-muted/60')}>
              <Zap className="size-3.5" aria-hidden /><span className={cn(!yolo.on && 'max-sm:sr-only')}>{yolo.words}</span>
            </a>
          )}
          <div className="hidden items-center gap-1.5 md:flex">
            <span className="text-muted-foreground">router</span>
            <span className="font-mono">{health?.router ?? '…'}</span>
            {health?.fallback && <StatusBadge status="fallback" tone="warn" />}
          </div>
          {health?.eventLoopStall && <StatusBadge status="stalled" tone="warn" title={stallTitle(health.eventLoopStall)} />}
          <span className="num hidden text-muted-foreground sm:inline">up {health ? duration(health.uptimeS) : '…'}</span>
          <span data-slot="connection" className="flex items-center gap-1.5 text-muted-foreground">
            <Dot tone={conn === 'live' ? 'ok' : 'warn'} pulse={conn === 'live'} /><span className="hidden sm:inline">{conn}</span>
          </span>
          <FileIssueButton compact />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="max-sm:hidden" asChild>
                <a href="/help/" target="_blank" rel="noopener" aria-label="Help"><CircleHelp /></a>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Help</TooltipContent>
          </Tooltip>
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
