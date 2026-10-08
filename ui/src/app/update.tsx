// Self-update (issue #44): the notice when an update is available, applying or failed — with
// what's new in plain words (issue #104) — and the panel behind the header's version (version, installed commit, what that
// version brought, channel, auto-update, check now), open at any time and on any screen (issue #165), and the same
// details as Settings → Version, which links to Settings → Version history (issue #246). Applying keeps running jobs running; the page reloads once the daemon runs the new commit.
import { ArrowUpCircle, ChevronDown, Info, RefreshCw, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Dot, TEXT, type Tone } from '@/components/status';
import { dismissNotice, useDismissed } from '@/hooks/use-dismissed';
import { useNow } from '@/hooks/use-now';
import { noticeKey } from '@/model/dismissed';
import { ago } from '@/model/format';
import { CHANNELS, headline, showNotice } from '@/model/update';
import type { UpdateStatus } from '@/model/wire';
import { cn } from '@/lib/utils';
import { updateAct, useHopper } from '@/store';
import { useCanAdminInstance } from '@/store/selectors';

const short = (sha: string | undefined) => sha?.slice(0, 7) ?? '…';
const TONE: Record<UpdateStatus['state'], Tone> = { available: 'busy', applying: 'warn', error: 'bad', current: 'ok', unavailable: 'muted' };

function WhatsNew({ lines }: { lines: string[] }) {
  return (
    <ul className="max-h-64 list-disc space-y-1 overflow-y-auto pl-4 text-xs">
      {lines.map((b) => <li key={b}>{b}</li>)}
    </ul>
  );
}

function ApplyButton({ s }: { s: UpdateStatus }) {
  const authed = useCanAdminInstance();
  if (s.state !== 'available' || s.installed?.kind === 'image') return null;
  return (
    <Button size="xs" disabled={!authed} title={authed ? 'Build the update beside the running hopper, then restart; running jobs keep running' : 'Only the hopper\'s admins can update'}
      onClick={() => void updateAct({ action: 'apply' }, 'Updating: running jobs keep running')}>
      <ArrowUpCircle />Update now
    </Button>
  );
}

export function UpdateNotice() {
  const s = useHopper((st) => st.update);
  const dismissed = useDismissed();
  const [open, setOpen] = useState(false);
  if (!s || !showNotice(s) || dismissed.includes(noticeKey.update(s))) return null;
  const tone = TONE[s.state];
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-update-notice
      className={cn('rounded-lg border px-3 py-2 text-sm', tone === 'bad' ? 'border-bad/40 bg-bad/5' : tone === 'warn' ? 'border-warn/40 bg-warn/5' : 'border-busy/40 bg-busy/5')}>
      <div className="flex flex-wrap items-center gap-2">
        <Dot tone={tone} pulse={s.state === 'applying'} />
        <span className={cn('min-w-0 flex-1 truncate font-medium', TEXT[tone])} title={headline(s)}>{headline(s)}</span>
        {s.whatsNew.length > 0 && (
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="xs">What's new<ChevronDown className={cn('transition-transform', open && 'rotate-180')} /></Button>
          </CollapsibleTrigger>
        )}
        <ApplyButton s={s} />
        <Button variant="ghost" size="icon-xs" aria-label="Dismiss" title="Dismiss: hide here, in this browser; the header version still shows the update"
          className="text-muted-foreground" onClick={() => dismissNotice(noticeKey.update(s))}><X /></Button>
      </div>
      <CollapsibleContent className="pt-2"><WhatsNew lines={s.whatsNew} /></CollapsibleContent>
    </Collapsible>
  );
}

/** The version and update details: version, installed commit, what this version brought, channel, auto-update, check now. */
export function VersionDetails({ className }: { className?: string }) {
  const s = useHopper((st) => st.update);
  const version = useHopper((st) => st.health?.version);
  const authed = useCanAdminInstance();
  const now = useNow();
  const [checking, setChecking] = useState(false);
  const check = async () => { setChecking(true); await updateAct({ action: 'check' }); setChecking(false); };
  if (!s) return <p className={cn('text-sm text-muted-foreground', className)}>Loading…</p>;
  return (
    <div data-slot="version-details" className={cn('space-y-4 text-sm', className)}>
      <p className={cn('text-xs', TEXT[TONE[s.state]])}>{headline(s)}</p>
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Version</dt>
        <dd className="font-mono">{version ?? '…'}</dd>
        <dt className="text-muted-foreground">Installed</dt>
        <dd className="font-mono">{s.installed ? `${s.installed.branch} ${short(s.installed.commit)}` : '—'}</dd>
        {s.installed && <><dt className="text-muted-foreground">Installed on</dt><dd>{new Date(s.installed.installedAt).toLocaleString()}</dd></>}
        {s.target && <><dt className="text-muted-foreground">Newest</dt><dd className="font-mono">{s.target.ref} {short(s.target.commit)}</dd></>}
        <dt className="text-muted-foreground">Release</dt>
        <dd className="font-mono">{s.release ? `${s.release.tag}${s.release.newer ? ' (newer)' : ''}` : 'none yet'}</dd>
        <dt className="text-muted-foreground">Checked</dt>
        <dd>{s.checkedAt ? ago(s.checkedAt, now) : 'not yet'}</dd>
      </dl>
      {s.state === 'applying' && s.apply && <p className={cn('text-xs', TEXT.warn)}>{s.apply.detail}</p>}
      {s.installed?.kind === 'image' && <p className="text-xs text-muted-foreground">Runs from a container image: pull or rebuild the image to update it; it is never updated in place.</p>}
      {(s.state === 'error' || s.state === 'unavailable') && s.reason && <p className={cn('text-xs break-words', s.state === 'error' ? TEXT.bad : TEXT.muted)}>{s.reason}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <ApplyButton s={s} />
        <Button variant="outline" size="xs" disabled={!authed || checking || s.state === 'unavailable' || s.state === 'applying'} onClick={() => void check()}>
          <RefreshCw className={cn(checking && 'animate-spin')} />Check now
        </Button>
      </div>
      <div className="space-y-2 border-t pt-3">
        <label className="flex items-center justify-between gap-3 text-xs">
          <span>Auto-update<span className="block text-muted-foreground">Apply an update as soon as a check finds it.</span></span>
          <Switch aria-label="Auto-update" checked={s.autoUpdate} disabled={!authed}
            onCheckedChange={(autoUpdate) => void updateAct({ action: 'settings', autoUpdate }, autoUpdate ? 'Auto-update on' : 'Auto-update off')} />
        </label>
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
          <span>Channel<span className="block text-muted-foreground">{CHANNELS.find((c) => c.channel === s.channel)?.hint}</span></span>
          <div className="flex gap-1">
            {CHANNELS.map(({ channel: c, hint }) => (
              <Button key={c} size="xs" variant={s.channel === c ? 'secondary' : 'ghost'} disabled={!authed || s.channel === c} title={hint}
                onClick={() => void updateAct({ action: 'settings', channel: c }, `Channel: ${c}`)}>{c}</Button>
            ))}
          </div>
        </div>
      </div>
      {s.whatsNew.length > 0 && <div className="space-y-1 border-t pt-3"><h3 className="text-xs font-medium">What's new in the update</h3><WhatsNew lines={s.whatsNew} /></div>}
      {s.installedWhatsNew.length > 0 && <div className="space-y-1 border-t pt-3"><h3 className="text-xs font-medium">In this version</h3><WhatsNew lines={s.installedWhatsNew} /></div>}
      <a href="#settings/version-history" className="block text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">Every version and what it brought: Settings → Version history</a>
      {!authed && <p className="text-xs text-muted-foreground">Read-only: only the hopper's admins can update or change these settings.</p>}
    </div>
  );
}

/** The header's version, on every screen: a button that opens the version and update panel; a dot when an update is available. */
export function UpdateButton({ version }: { version: string | undefined }) {
  const s = useHopper((st) => st.update);
  return (
    <Sheet>
      <SheetTrigger asChild>
        <button type="button" className="inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground" aria-label="Version and updates" title="Version and updates: what you run and what it brought">
          <Info className="size-3" />{version}{s?.installed && <span className="hidden sm:inline">· {short(s.installed.commit)}</span>}
          {s && showNotice(s) && <Dot tone={TONE[s.state]} pulse={s.state === 'applying'} />}
        </button>
      </SheetTrigger>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Version and updates</SheetTitle>
          <SheetDescription>What you run, what it brought, and how it updates. Also under Settings → Version.</SheetDescription>
        </SheetHeader>
        <VersionDetails className="px-4 pb-4" />
      </SheetContent>
    </Sheet>
  );
}
