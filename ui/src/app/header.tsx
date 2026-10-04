// The top bar: connection, router mode (switchable with a session), router health, uptime, login,
// and a device link for another browser.
import { LogOut, Moon, Rabbit, Sun } from 'lucide-react';
import { setTheme, useTheme } from '@/hooks/use-theme';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Dot, StatusBadge } from '@/components/status';
import { duration } from '@/model/format';
import { act, logout, refreshHealth, useHopper } from '@/store';
import { DeviceLink } from './device-link';

export function Header({ nav }: { nav?: React.ReactNode }) {
  const health = useHopper((s) => s.health);
  const conn = useHopper((s) => s.conn);
  const authed = useHopper((s) => s.authed);
  const theme = useTheme();
  const mode = health?.routerMode;
  const next = mode === 'active' ? 'shadow' : 'active';
  return (
    <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur-md">
      <div className="flex h-14 items-center gap-3 px-4 lg:px-6">
        {nav}
        <div className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="grid size-7 place-items-center rounded-md bg-busy/15 text-busy"><Rabbit className="size-4" /></span>
          job-hopper
        </div>
        <span className="hidden font-mono text-[11px] text-muted-foreground sm:inline">{health?.version}</span>
        <div className="ml-auto flex items-center gap-2 text-xs sm:gap-3">
          <div className="hidden items-center gap-1.5 md:flex">
            <span className="text-muted-foreground">router</span>
            <span className="font-mono">{health?.router ?? '…'}</span>
            {health?.fallback && <StatusBadge status="fallback" tone="warn" />}
          </div>
          {mode && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="xs" disabled={!authed} className="gap-1.5"
                  onClick={() => act('/ui/api/router-mode', { mode: next }, `Router mode: ${next}`).then(() => refreshHealth())}>
                  <span className={mode === 'active' ? 'text-warn' : 'text-muted-foreground'}>{mode}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>{authed ? `Router mode. Click to switch to ${next}.` : 'Router mode. Log in to switch.'}</TooltipContent>
            </Tooltip>
          )}
          <span className="num hidden text-muted-foreground sm:inline">up {health ? duration(health.uptimeS) : '…'}</span>
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Dot tone={conn === 'live' ? 'ok' : 'warn'} pulse={conn === 'live'} /><span className="hidden sm:inline">{conn}</span>
          </span>
          <Button variant="ghost" size="icon-sm" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun /> : <Moon />}</Button>
          {authed && <DeviceLink />}
          {authed && <Button variant="ghost" size="icon-sm" aria-label="Log out" onClick={() => void logout()}><LogOut /></Button>}
        </div>
      </div>
    </header>
  );
}
