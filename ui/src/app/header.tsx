// The top bar: version (opens the version and update panel, on every screen), connection,
// router health, uptime, the API reference, who you are at every width (issue #167: the user the session
// acts for with its role), logout, and a device link for another browser. Shown only signed in (issue #213).
import { BookOpen, LogOut, Moon, Sun } from 'lucide-react';
import logo from '../../../site/hopper-logo.svg';
import { setTheme, useTheme } from '@/hooks/use-theme';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Dot, StatusBadge } from '@/components/status';
import { duration } from '@/model/format';
import { logout, useHopper } from '@/store';
import { useCanAdmin } from '@/store/selectors';
import { DeviceLink } from './device-link';
import { UpdateButton } from './update';

export function Header({ nav }: { nav?: React.ReactNode }) {
  const health = useHopper((s) => s.health);
  const conn = useHopper((s) => s.conn);
  const user = useHopper((s) => s.user);
  const local = useHopper((s) => s.signIn?.local ?? false);
  const canAdmin = useCanAdmin();
  const theme = useTheme();
  return (
    <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur-md">
      <div className="flex h-14 items-center gap-3 px-4 lg:px-6">
        {nav}
        <div className="flex items-center gap-2 font-semibold tracking-tight">
          <img src={logo} alt="" className="h-7 w-auto" />
          hopper
        </div>
        <UpdateButton version={health?.version} />
        <div className="ml-auto flex items-center gap-2 text-xs sm:gap-3">
          <div className="hidden items-center gap-1.5 md:flex">
            <span className="text-muted-foreground">router</span>
            <span className="font-mono">{health?.router ?? '…'}</span>
            {health?.fallback && <StatusBadge status="fallback" tone="warn" />}
          </div>
          <span className="num hidden text-muted-foreground sm:inline">up {health ? duration(health.uptimeS) : '…'}</span>
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Dot tone={conn === 'live' ? 'ok' : 'warn'} pulse={conn === 'live'} /><span className="hidden sm:inline">{conn}</span>
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" asChild>
                <a href="/docs/" target="_blank" rel="noopener" aria-label="API reference"><BookOpen /></a>
              </Button>
            </TooltipTrigger>
            <TooltipContent>API reference</TooltipContent>
          </Tooltip>
          <Button variant="ghost" size="icon-sm" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun /> : <Moon />}</Button>
          {user && (
            <span data-who className="flex items-center gap-1.5" title={`Signed in as ${user.name}: ${user.identity}, with ${user.realm}`}>
              <span className="max-w-24 truncate sm:max-w-40">{user.name}</span><StatusBadge status={user.role} tone="muted" />
            </span>
          )}
          {canAdmin && local && <DeviceLink />}
          <Button variant="ghost" size="icon-sm" aria-label="Log out" onClick={() => void logout()}><LogOut /></Button>
        </div>
      </div>
    </header>
  );
}
