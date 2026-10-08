// Self-update (issue #44): the notice when an update is available, applying or failed — with
// what's new in plain words (issue #104) — and the panel behind the header's version (version, installed commit, what that
// version brought, channel, auto-update, check now), open at any time and on any screen (issue #165), and the same
// details as Settings → Version, which links to Settings → Version history (issue #246). The update's notes and the installed version's notes are two labelled sections that scroll with the page (issue #493). Applying keeps running jobs running; the page reloads once the daemon runs the new commit.
// A container install is updated by its user (issue #494): no Update now, no Auto-update, and the exact commands for the selected channel's image tag.
// The notice is one line until asked (issue #521): What's new and How to update open below it, one at a time; the commands are one container tool's, the one this browser chose last.
// The header badge names the channel on dev and beta, and both channels when the running build is another channel's (issue #497).
import { ArrowUpCircle, ChevronDown, Info, RefreshCw, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Dot, TEXT, type Tone } from '@/components/status';
import { setContainerTool, useContainerTool } from '@/hooks/use-container-tool';
import { dismissNotice, useDismissed } from '@/hooks/use-dismissed';
import { useNow } from '@/hooks/use-now';
import { noticeKey } from '@/model/dismissed';
import { ago } from '@/model/format';
import { CHANNELS, CONTAINER_TOOLS, channelBadge, headline, imageUpdate, showNotice } from '@/model/update';
import type { UpdateStatus } from '@/model/wire';
import { cn } from '@/lib/utils';
import { updateAct, useHopper } from '@/store';
import { useCanAdminInstance } from '@/store/selectors';

const short = (sha: string | undefined) => sha?.slice(0, 7) ?? '…';
const TONE: Record<UpdateStatus['state'], Tone> = { available: 'busy', applying: 'warn', error: 'bad', current: 'ok', unavailable: 'muted' };

/** How many notes a list shows before its Show all (issue #493). */
const FIRST = 5;

/** Release notes as a plain list that scrolls with the page: the first few, and a Show all that opens the rest in place (issue #493). */
function WhatsNew({ lines }: { lines: string[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? lines : lines.slice(0, FIRST);
  return (
    <div className="space-y-1">
      <ul className="list-disc space-y-1 pl-4 text-xs break-words">
        {shown.map((b) => <li key={b}>{b}</li>)}
      </ul>
      {lines.length > FIRST && (
        <Button variant="link" size="xs" className="h-auto px-0 text-xs" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${lines.length}`}
        </Button>
      )}
    </div>
  );
}

/** One release-notes section of the version panel, its heading naming the commit it belongs to (issue #493). */
function Notes({ slot, title, hint, lines, primary }: { slot: string; title: string; hint: string; lines: string[]; primary?: boolean }) {
  return (
    <section data-slot={slot} className={cn('space-y-1', primary ? 'rounded-lg border border-busy/40 bg-busy/5 p-3' : 'border-t pt-3 text-muted-foreground')}>
      <h3 className={cn('text-xs font-medium', primary ? TEXT.busy : 'text-foreground')}>{title}</h3>
      <p className="text-xs text-muted-foreground">{hint}</p>
      <WhatsNew lines={lines} />
    </section>
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

function Command({ text }: { text: string }) {
  const copy = () => navigator.clipboard?.writeText(text).then(() => toast.success('Copied'), () => toast.error('Clipboard blocked'));
  return (
    <div className="flex items-start gap-2">
      <pre className="min-w-0 flex-1 overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-[11px]">{text}</pre>
      <Button variant="outline" size="xs" onClick={() => void copy()}>Copy</Button>
    </div>
  );
}

/** How to update a container install: the channel's tag in .env, pull and recreate the hopper's container, prune — for the chosen container tool; and what a recreate would end now. */
function ImageUpdateSteps({ s }: { s: UpdateStatus }) {
  const tool = useContainerTool();
  const u = imageUpdate(s);
  if (!u) return null;
  const c = u.commands.find((x) => x.tool === tool) ?? u.commands[0]!;
  return (
    <div data-slot="image-update" className="space-y-2 text-xs">
      {u.mismatch && <p className={TEXT.warn}>{u.mismatch}.</p>}
      <p>In the folder that holds <code>compose.yaml</code>, set the {s.channel} channel's image in <code>.env</code> beside it{s.channel === 'stable' && <> (<code>latest</code> is the same image)</>}:</p>
      <Command text={u.env} />
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-muted-foreground">Pull the image and recreate the hopper's container (Postgres and the volumes stay as they are); then, optionally, remove the image it replaced.</p>
        <div data-slot="container-tool" className="flex gap-1">
          {CONTAINER_TOOLS.map((t) => (
            <Button key={t} data-tool={t} size="xs" variant={t === tool ? 'secondary' : 'ghost'} aria-pressed={t === tool} onClick={() => setContainerTool(t)}>{t}</Button>
          ))}
        </div>
      </div>
      <Command text={c.update} />
      <Command text={c.prune} />
      <p className={s.restartBlockers > 0 ? TEXT.warn : 'text-muted-foreground'} data-slot="restart-blockers">{u.blockers}</p>
    </div>
  );
}

/** What opens below the notice's line: one at a time. */
type Panel = 'news' | 'steps';

function PanelToggle({ panel, open, onOpen, children }: { panel: Panel; open: Panel | null; onOpen: (p: Panel | null) => void; children: string }) {
  return (
    <Button variant="ghost" size="xs" aria-expanded={open === panel} onClick={() => onOpen(open === panel ? null : panel)}>
      {children}<ChevronDown className={cn('transition-transform', open === panel && 'rotate-180')} />
    </Button>
  );
}

export function UpdateNotice() {
  const s = useHopper((st) => st.update);
  const dismissed = useDismissed();
  const [open, setOpen] = useState<Panel | null>(null);
  if (!s || !showNotice(s) || dismissed.includes(noticeKey.update(s))) return null;
  const tone = TONE[s.state];
  const image = imageUpdate(s) !== undefined;
  return (
    <div data-update-notice
      className={cn('rounded-lg border px-3 py-1.5 text-sm', tone === 'bad' ? 'border-bad/40 bg-bad/5' : tone === 'warn' ? 'border-warn/40 bg-warn/5' : 'border-busy/40 bg-busy/5')}>
      <div className="flex flex-wrap items-center gap-2">
        <Dot tone={tone} pulse={s.state === 'applying'} />
        <span className={cn('min-w-0 flex-1 truncate font-medium', TEXT[tone])} title={headline(s)}>{headline(s)}</span>
        {s.whatsNew.length > 0 && <PanelToggle panel="news" open={open} onOpen={setOpen}>What's new</PanelToggle>}
        {image && <PanelToggle panel="steps" open={open} onOpen={setOpen}>How to update</PanelToggle>}
        <ApplyButton s={s} />
        <Button variant="ghost" size="icon-xs" aria-label="Dismiss" title="Dismiss: hide here, in this browser; the header version still shows the update"
          className="text-muted-foreground" onClick={() => dismissNotice(noticeKey.update(s))}><X /></Button>
      </div>
      {open === 'news' && s.whatsNew.length > 0 && <div className="pt-2"><WhatsNew lines={s.whatsNew} /></div>}
      {open === 'steps' && image && <div className="pt-2"><ImageUpdateSteps s={s} /></div>}
    </div>
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
  const pending = s.whatsNew.length > 0 && s.target !== undefined;
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
        <dt className="text-muted-foreground">Checked</dt>
        <dd>{s.checkedAt ? ago(s.checkedAt, now) : 'not yet'}</dd>
      </dl>
      {s.state === 'applying' && s.apply && <p className={cn('text-xs', TEXT.warn)}>{s.apply.detail}</p>}
      {s.installed?.kind === 'image' && (imageUpdate(s)
        ? <ImageUpdateSteps s={s} />
        : <p className="text-xs text-muted-foreground">Runs from a container image: you update it by pulling the image of its channel; the hopper never updates it in place.</p>)}
      {(s.state === 'error' || s.state === 'unavailable') && s.reason && <p className={cn('text-xs break-words', s.state === 'error' ? TEXT.bad : TEXT.muted)}>{s.reason}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <ApplyButton s={s} />
        <Button variant="outline" size="xs" disabled={!authed || checking || s.state === 'unavailable' || s.state === 'applying'} onClick={() => void check()}>
          <RefreshCw className={cn(checking && 'animate-spin')} />Check now
        </Button>
      </div>
      <div className="space-y-2 border-t pt-3">
        {s.installed?.kind === 'image'
          ? <p data-slot="auto-update-image" className="text-xs text-muted-foreground">Auto-update does not apply to a container: you update it by pulling its image.</p>
          : (
            <label className="flex items-center justify-between gap-3 text-xs">
              <span>Auto-update<span className="block text-muted-foreground">Apply an update as soon as a check finds it.</span></span>
              <Switch aria-label="Auto-update" checked={s.autoUpdate} disabled={!authed}
                onCheckedChange={(autoUpdate) => void updateAct({ action: 'settings', autoUpdate }, autoUpdate ? 'Auto-update on' : 'Auto-update off')} />
            </label>
          )}
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
          <span>Channel<span className="block text-muted-foreground">{CHANNELS.find((c) => c.channel === s.channel)?.hint}</span></span>
          <div data-slot="update-channels" className="flex gap-1">
            {CHANNELS.map(({ channel: c, hint }) => (
              <Button key={c} size="xs" variant={s.channel === c ? 'secondary' : 'ghost'} disabled={!authed || s.channel === c} title={hint}
                onClick={() => void updateAct({ action: 'settings', channel: c }, `Channel: ${c}`)}>{c}</Button>
            ))}
          </div>
        </div>
      </div>
      {pending && s.target && <Notes slot="update-notes" primary title={`Coming in the update · ${s.target.ref} ${short(s.target.commit)}`}
        hint="Not installed yet: what updating would bring." lines={s.whatsNew} />}
      {s.installedWhatsNew.length > 0 && <Notes slot="installed-notes" lines={s.installedWhatsNew}
        title={`${pending ? 'Already installed' : 'In this version'} · ${s.installed ? `${s.installed.branch} ${short(s.installed.commit)}` : 'this build'}`}
        hint={pending ? 'What the version you run now brought: you have these already.' : 'What the version you run now brought.'} />}
      <a href="#settings/version-history" className="block text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">Every version and what it brought: Settings → Version history</a>
      {!authed && <p className="text-xs text-muted-foreground">Read-only: only the hopper's admins can update or change these settings.</p>}
    </div>
  );
}

/** The header's version, on every screen: a button that opens the version and update panel; a dot when an update is available. */
export function UpdateButton({ version }: { version: string | undefined }) {
  const s = useHopper((st) => st.update);
  // On a phone the channel stays visible; the commit, and the icon and version beside a channel, give way (issue #497).
  const channel = s ? channelBadge(s) : undefined;
  const label = channel ? `Version and updates: ${channel.label}` : 'Version and updates';
  return (
    <Sheet>
      <SheetTrigger asChild>
        <button type="button" className="inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground" aria-label={label} title={`${label}. What you run and what it brought`}>
          <Info className={cn('size-3', channel?.tag && 'max-sm:hidden')} /><span className={cn(channel?.tag && 'max-sm:hidden')}>{version}</span>{s?.installed && <span className="hidden sm:inline">· {short(s.installed.commit)}</span>}
          {channel?.tag && (
            <span data-slot="badge-channel" data-mismatch={channel.mismatch} className={cn('rounded-sm px-1 whitespace-nowrap', channel.mismatch ? 'bg-warn/15 text-warn' : 'bg-muted text-foreground')}>{channel.tag}</span>
          )}
          {s && showNotice(s) && <span data-slot="update-dot" className="inline-flex"><Dot tone={TONE[s.state]} pulse={s.state === 'applying'} /></span>}
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
