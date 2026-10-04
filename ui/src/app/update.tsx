// Self-update (issue #44): the notice when an update is available, applying or failed — with what
// changed — and the panel behind the header's version (installed commit, channel, auto-update,
// check now). Applying keeps running jobs running; the page reloads once the daemon runs the new commit.
import { ArrowUpCircle, ChevronDown, ExternalLink, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Dot, TEXT, type Tone } from '@/components/status';
import { useNow } from '@/hooks/use-now';
import { ago } from '@/model/format';
import { compareUrl, headline, showNotice } from '@/model/update';
import type { UpdateStatus } from '@/model/wire';
import { cn } from '@/lib/utils';
import { updateAct, useHopper } from '@/store';

const short = (sha: string | undefined) => sha?.slice(0, 7) ?? '…';
const TONE: Record<UpdateStatus['state'], Tone> = { available: 'busy', applying: 'warn', error: 'bad', current: 'ok', unavailable: 'muted' };

function Changes({ s }: { s: UpdateStatus }) {
  const link = s.installed && s.target ? compareUrl(s.installed.repo, s.installed.commit, s.target.commit) : undefined;
  if (s.changes.length === 0) return null;
  return (
    <div className="space-y-1">
      <ul className="max-h-64 space-y-0.5 overflow-y-auto text-xs">
        {s.changes.map((c) => (
          <li key={c.commit} className="grid grid-cols-[4rem_minmax(0,1fr)] gap-2">
            <span className="font-mono text-muted-foreground" title={c.at}>{short(c.commit)}</span>
            <span className="truncate" title={c.subject}>{c.subject}</span>
          </li>
        ))}
      </ul>
      {s.truncated && <p className="text-xs text-muted-foreground">Only the newest {s.changes.length} are listed.</p>}
      {link && <a className="inline-flex items-center gap-1 text-xs text-busy hover:underline" href={link} target="_blank" rel="noreferrer">Compare on GitHub<ExternalLink className="size-3" /></a>}
    </div>
  );
}

function ApplyButton({ s }: { s: UpdateStatus }) {
  const authed = useHopper((st) => st.authed);
  if (s.state !== 'available') return null;
  return (
    <Button size="xs" disabled={!authed} title={authed ? 'Build the update beside the running hopper, then restart; running jobs keep running' : 'Log in to update'}
      onClick={() => void updateAct({ action: 'apply' }, 'Updating: running jobs keep running')}>
      <ArrowUpCircle />Update now
    </Button>
  );
}

export function UpdateNotice() {
  const s = useHopper((st) => st.update);
  const [open, setOpen] = useState(false);
  if (!s || !showNotice(s)) return null;
  const tone = TONE[s.state];
  return (
    <Collapsible open={open} onOpenChange={setOpen}
      className={cn('rounded-lg border px-3 py-2 text-sm', tone === 'bad' ? 'border-bad/40 bg-bad/5' : tone === 'warn' ? 'border-warn/40 bg-warn/5' : 'border-busy/40 bg-busy/5')}>
      <div className="flex flex-wrap items-center gap-2">
        <Dot tone={tone} pulse={s.state === 'applying'} />
        <span className={cn('min-w-0 flex-1 truncate font-medium', TEXT[tone])} title={headline(s)}>{headline(s)}</span>
        {s.changes.length > 0 && (
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="xs">What changed<ChevronDown className={cn('transition-transform', open && 'rotate-180')} /></Button>
          </CollapsibleTrigger>
        )}
        <ApplyButton s={s} />
      </div>
      <CollapsibleContent className="pt-2"><Changes s={s} /></CollapsibleContent>
    </Collapsible>
  );
}

/** The header's version: opens the update panel; a dot when an update is available. */
export function UpdateButton({ version }: { version: string | undefined }) {
  const s = useHopper((st) => st.update);
  const authed = useHopper((st) => st.authed);
  const now = useNow();
  const [checking, setChecking] = useState(false);
  const check = async () => { setChecking(true); await updateAct({ action: 'check' }); setChecking(false); };
  return (
    <Sheet>
      <SheetTrigger asChild>
        <button type="button" className="hidden items-center gap-1.5 rounded px-1 font-mono text-[11px] text-muted-foreground hover:text-foreground sm:inline-flex" aria-label="Updates">
          {version}{s?.installed && <span>· {short(s.installed.commit)}</span>}
          {s && showNotice(s) && <Dot tone={TONE[s.state]} pulse={s.state === 'applying'} />}
        </button>
      </SheetTrigger>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Updates</SheetTitle>
          <SheetDescription>{s ? headline(s) : 'Loading…'}</SheetDescription>
        </SheetHeader>
        {s && (
          <div className="space-y-4 px-4 pb-4 text-sm">
            <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">Installed</dt>
              <dd className="font-mono">{s.installed ? `${s.installed.branch} ${short(s.installed.commit)}` : '—'}</dd>
              {s.target && <><dt className="text-muted-foreground">Newest</dt><dd className="font-mono">{s.target.ref} {short(s.target.commit)}</dd></>}
              <dt className="text-muted-foreground">Release</dt>
              <dd className="font-mono">{s.release ? `${s.release.tag}${s.release.newer ? ' (newer)' : ''}` : 'none yet'}</dd>
              <dt className="text-muted-foreground">Checked</dt>
              <dd>{s.checkedAt ? ago(s.checkedAt, now) : 'not yet'}</dd>
            </dl>
            {s.state === 'applying' && s.apply && <p className={cn('text-xs', TEXT.warn)}>{s.apply.detail}</p>}
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
              <div className="flex items-center justify-between gap-3 text-xs">
                <span>Channel<span className="block text-muted-foreground">Every commit on {s.installed?.branch ?? 'main'}, or release tags only.</span></span>
                <div className="flex gap-1">
                  {(['main', 'release'] as const).map((c) => (
                    <Button key={c} size="xs" variant={s.channel === c ? 'secondary' : 'ghost'} disabled={!authed || s.channel === c}
                      onClick={() => void updateAct({ action: 'settings', channel: c }, `Channel: ${c}`)}>{c === 'main' ? 'commits' : 'releases'}</Button>
                  ))}
                </div>
              </div>
            </div>
            {s.changes.length > 0 && <div className="space-y-1 border-t pt-3"><h3 className="text-xs font-medium">What changed</h3><Changes s={s} /></div>}
            {!authed && <p className="text-xs text-muted-foreground">Read-only: log in to update or change these settings.</p>}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
