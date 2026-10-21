// The user menu (issue #666): one button in the top bar, the user's initials, at every width. It opens a menu
// with who you are (issue #167: the user the session acts for, with its role), the theme, the device link for
// another browser (an admin's, on a local sign-in), and last, set apart, Sign out. Sign out needs a second tap,
// so a stray tap on a phone signs nobody out; the menu closes on an outside tap or Escape, and asks again when
// it opens again. Every target is at least 44 px. Report a bug (issue #694) opens the report form; File an issue (issue #471)
// its dialog, off with the reason while no provider can draft — on a phone the only place it is.
// Help (issue #782) opens the help pages of this version in a new tab, for every role. Your reports (#reports) and Version
// history (#settings/version-history) are here, not in the navigation (issue #2374): neither waits on anyone.
import { Bug, CircleHelp, ClipboardList, FilePlus, LogOut, MonitorSmartphone, Moon, ScrollText, Sun } from 'lucide-react';
import { useState } from 'react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { StatusBadge } from '@/components/status';
import { setTheme, useTheme } from '@/hooks/use-theme';
import { logout, useHopper } from '@/store';
import { useCanAdmin, useCanOperate } from '@/store/selectors';
import { useBugReport } from './bug-report';
import { useFileIssue } from './file-issue';
import { useDeviceLink } from './device-link';

/** Up to two letters: the first of the first and last words of the name. */
export function initials(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  const first = words[0]?.[0] ?? '?';
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

const ITEM = 'min-h-11';

export function UserMenu() {
  const user = useHopper((s) => s.user);
  const local = useHopper((s) => s.signIn?.local ?? false);
  const canAdmin = useCanAdmin();
  const canOperate = useCanOperate();
  const theme = useTheme();
  const device = useDeviceLink();
  const report = useBugReport();
  const fileIssue = useFileIssue();
  const [armed, setArmed] = useState(false);
  if (!user) return null;
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <>
      <DropdownMenu onOpenChange={() => setArmed(false)}>
        <DropdownMenuTrigger data-slot="user-menu-trigger" aria-label={`User menu: ${user.name}, ${user.role}`}
          title={`Signed in as ${user.name}: ${user.identity}, with ${user.realm}`}
          className="flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
          <span className="flex size-8 items-center justify-center rounded-full border bg-muted text-xs font-semibold text-foreground">{initials(user.name)}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent data-slot="user-menu" align="end" className="w-64">
          <DropdownMenuLabel data-who className="flex min-h-11 items-center gap-2">
            <span className="min-w-0 truncate">{user.name}</span><StatusBadge status={user.role} tone="muted" />
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem className={ITEM} onSelect={(e) => { e.preventDefault(); setTheme(next); }}>
            {next === 'light' ? <Sun /> : <Moon />}{next === 'light' ? 'Light theme' : 'Dark theme'}
          </DropdownMenuItem>
          <DropdownMenuItem className={ITEM} asChild>
            <a href="/help/" target="_blank" rel="noopener"><CircleHelp />Help</a>
          </DropdownMenuItem>
          <DropdownMenuItem className={ITEM} asChild><a href="#reports"><ClipboardList />Your reports</a></DropdownMenuItem>
          <DropdownMenuItem className={ITEM} asChild><a href="#settings/version-history"><ScrollText />Version history</a></DropdownMenuItem>
          {canAdmin && local && (
            <DropdownMenuItem className={ITEM} onSelect={device.open}><MonitorSmartphone />Log in another device</DropdownMenuItem>
          )}
          {fileIssue.state.show && (
            <DropdownMenuItem className={ITEM} disabled={fileIssue.state.disabled} title={fileIssue.state.title} onSelect={() => fileIssue.open()}><FilePlus />File an issue</DropdownMenuItem>
          )}
          {canOperate && <DropdownMenuItem className={ITEM} onSelect={() => report.open()}><Bug />Report a bug</DropdownMenuItem>}
          <DropdownMenuSeparator />
          <DropdownMenuItem className={ITEM} variant="destructive"
            onSelect={(e) => { if (armed) { void logout(); return; } e.preventDefault(); setArmed(true); }}>
            <LogOut />{armed ? 'Tap again to sign out' : 'Sign out'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {device.dialog}
      {report.dialog}
      {fileIssue.dialog}
    </>
  );
}
