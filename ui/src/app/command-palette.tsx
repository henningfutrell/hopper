// The command palette (issue #2661, design.md "The command palette", model/command-palette.ts): Cmd-K or Ctrl-K on every
// screen, or the header's button, opens one search over the pages, the commands the person's role allows (from the scope
// registry, GET /api/scopes), the jobs, issues, pull requests, artifacts and infra plans (the jobs the page holds, and the
// search index's suggestions, GET /api/search/suggest: the hopper's own copy, never GitHub), the open questions, the
// machines, the vault by names only, and the settings. Results are grouped by kind; arrows, Enter and Escape do all of it.
// A job picked shows its actions: Open, and each job action of the registry the role allows. Approve, End wait, Re-queue,
// Lift quarantine, Approve trust, Dismiss, Run again and Cancel run here (Cancel asks Enter once more); any other opens the
// job, where it is done. With no words, the recent picks show. The last entry opens the Search view on the words.
import { ArrowLeft, Search } from 'lucide-react';
import { Command, defaultFilter } from 'cmdk';
import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { get } from '@/lib/api';
import { cn } from '@/lib/utils';
import { commandEntries, jobActions, jobEntries, pageEntries, PALETTE_GROUPS, parseRecent, settingsEntries, suggestionEntries, vaultEntries, withRecent, type JobAction, type PaletteEntry } from '@/model/command-palette';
import { emptySearch, hitHref, searchHash, suggestPath } from '@/model/search';
import type { ScopeRegistry, SuggestAnswer } from '@/model/wire';
import { act, useHopper } from '@/store';
import { giveBack } from '@/store/give-back';
import { useVault } from '@/store/vault';
import { SETTINGS_SECTIONS } from '@/views/settings';
import { PAGE_TABS, VIEWS, viewLabel } from './nav';

export const usePalette = create<{ open: boolean }>(() => ({ open: false }));
export const openPalette = (): void => usePalette.setState({ open: true });

const PAUSE_MS = 150;
const MIN_CHARS = 2;
const RECENT_KEY = 'hopper.palette.recent';

/** The job actions that run from the palette with no more input, and what each says once sent. */
const RUN_HERE: Readonly<Record<string, string>> = {
  approve: 'Job approved', 'end-wait': 'Wait ended', requeue: 'Job re-queued', unquarantine: 'Quarantine lifted', 'approve-trust': 'Trust approved', dismiss: 'Entry dismissed', cancel: 'Job cancelled',
};

const PAGES = pageEntries([
  ...VIEWS.map((v) => ({ hash: `#${v}`, label: viewLabel(v) })),
  ...Object.entries(PAGE_TABS).flatMap(([page, tabs]) => tabs.slice(1).map((t) => ({ hash: `#${page}/${t.id}`, label: t.label, under: viewLabel(page as (typeof VIEWS)[number]) }))),
  { hash: '#reports', label: viewLabel('reports') }, { hash: '#search', label: viewLabel('search') },
]);
const SETTINGS = settingsEntries(SETTINGS_SECTIONS);

let registry: Promise<ScopeRegistry> | null = null;
/** The scope registry, read once per page. */
const readRegistry = (): Promise<ScopeRegistry> => (registry ??= get<ScopeRegistry>('/api/scopes').catch((e: unknown) => { registry = null; throw e; }));

function readRecent(): PaletteEntry[] { try { return parseRecent(localStorage.getItem(RECENT_KEY)); } catch { return []; } }
function keepRecent(list: PaletteEntry[]): void { try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* no storage: no recents */ } }

/** Opens a hash in the hopper, or an https link (an item on GitHub) in a new tab. */
function goTo(href: string): void {
  if (href.startsWith('https://')) window.open(href, '_blank', 'noopener,noreferrer');
  else window.location.hash = href;
}

/** Matches the words against an entry's label and keywords, not its id. */
const filter = (_value: string, search: string, keywords?: string[]): number => defaultFilter(keywords?.[0] ?? '', search, keywords?.slice(1));

/** The header's button, and the shortcut on every screen. */
export function CommandPaletteButton() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); usePalette.setState((s) => ({ open: !s.open })); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const mac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
  return (
    <>
      <button type="button" data-slot="palette-button" onClick={openPalette} aria-label="Search or run a command" aria-keyshortcuts="Meta+K Control+K"
        className="flex h-8 min-w-0 items-center gap-2 rounded-lg border border-input px-2 text-sm text-muted-foreground hover:bg-muted/60 md:w-full md:max-w-xs dark:bg-input/30">
        <Search className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate max-md:sr-only">Search or run a command</span>
        <kbd className="ml-auto hidden rounded border bg-muted px-1 font-mono text-[10px] md:inline">{mac ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
      <CommandPalette />
    </>
  );
}

export function CommandPalette() {
  const open = usePalette((s) => s.open);
  return (
    <Command.Dialog open={open} onOpenChange={(o) => usePalette.setState({ open: o })} label="Command palette" filter={filter} loop
      overlayClassName="fixed inset-0 z-50 bg-black/40" contentClassName="fixed top-[12vh] left-1/2 z-50 w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-xl">
      {open && <PaletteBody close={() => usePalette.setState({ open: false })} />}
    </Command.Dialog>
  );
}

function PaletteBody({ close }: { close: () => void }) {
  const [words, setWords] = useState('');
  const [forJob, setForJob] = useState<PaletteEntry | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [scopes, setScopes] = useState<ScopeRegistry | null>(null);
  const [recent, setRecent] = useState(readRecent);
  const role = useHopper((s) => s.user?.role ?? 'viewer');
  const jobs = useHopper((s) => s.jobs);
  const questions = useHopper((s) => s.questions);
  const machines = useHopper((s) => s.machines);
  const vault = useVault();
  useEffect(() => { readRegistry().then(setScopes, () => setScopes(null)); }, []);

  const q = words.trim();
  const [found, setFound] = useState<{ q: string; suggestions: SuggestAnswer['suggestions'] }>({ q: '', suggestions: [] });
  const asked = useRef('');
  useEffect(() => {
    if (forJob || q.length < MIN_CHARS) return undefined;
    const timer = setTimeout(() => {
      asked.current = q;
      get<SuggestAnswer>(suggestPath(q)).then((a) => { if (asked.current === q) setFound({ q, suggestions: a.suggestions ?? [] }); }, () => { if (asked.current === q) setFound({ q, suggestions: [] }); });
    }, PAUSE_MS);
    return () => clearTimeout(timer);
  }, [q, forJob]);

  const held = useMemo(() => jobEntries(Object.values(jobs)), [jobs]);
  const entries = useMemo<PaletteEntry[]>(() => [
    ...PAGES,
    ...(scopes ? commandEntries(scopes, role, SETTINGS_SECTIONS.map((s) => s.id)) : []),
    ...held,
    ...questions.map((x) => ({ id: `question:${x.id}`, group: 'Questions' as const, label: x.text.split('\n')[0]!.slice(0, 120), keywords: [x.jobId], href: '#questions' })),
    ...machines.map((m) => ({ id: `machine:${m.id}`, group: 'Machines' as const, label: m.label, keywords: [m.id], href: '#machines' })),
    ...vaultEntries(vault),
    ...SETTINGS,
  ], [scopes, role, held, questions, machines, vault]);
  const suggested = useMemo(() => (found.q === q ? suggestionEntries(found.suggestions, new Set(held.map((e) => e.id)), hitHref) : []), [found, q, held]);
  const actions = useMemo<JobAction[]>(() => (scopes ? jobActions(scopes, role) : []), [scopes, role]);

  const remember = (e: PaletteEntry) => { const next = withRecent(recent, e); setRecent(next); keepRecent(next); };
  const go = (href: string) => { close(); goTo(href); };
  const pick = (e: PaletteEntry) => {
    remember(e);
    if (e.job !== undefined) { setForJob(e); setWords(''); return; }
    go(e.href);
  };
  const runAction = (job: string, a: JobAction) => {
    if (a.act === 'cancel' && armed !== a.act) { setArmed(a.act); return; }
    const path = `/ui/api/jobs/${encodeURIComponent(job)}/${a.act}`;
    if (a.act === 'rerun') void giveBack(job, 'rerun');
    else if (RUN_HERE[a.act]) void act(path, {}, RUN_HERE[a.act]);
    else { go(`#job/${encodeURIComponent(job)}`); return; }
    close();
  };

  const item = (e: PaletteEntry, force = false) => (
    <Command.Item key={e.id} value={e.id} keywords={[e.label, ...(e.hint ? [e.hint] : []), ...(e.keywords ?? [])]} forceMount={force} onSelect={() => pick(e)}
      data-slot="palette-item" data-group={e.group} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm data-[selected=true]:bg-muted">
      <span className="min-w-0 flex-1 truncate">{e.label}</span>
      {e.hint && <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{e.hint}</span>}
    </Command.Item>
  );

  return (
    <>
      <div className="flex items-center gap-2 border-b px-3">
        {forJob ? <button type="button" aria-label="Back" onClick={() => setForJob(null)} className="text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /></button> : <Search className="size-4 text-muted-foreground" aria-hidden />}
        <Command.Input value={words} onValueChange={(v) => { setWords(v); setArmed(null); }} placeholder={forJob ? `Act on ${forJob.label}` : 'Search pages, commands, jobs, settings…'}
          onKeyDown={(e) => { if (forJob && e.key === 'Backspace' && words === '') { e.preventDefault(); setForJob(null); } }}
          data-slot="palette-input" className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
      </div>
      <Command.List className="max-h-[60vh] overflow-y-auto overscroll-contain p-1.5">
        <Command.Empty className="px-2 py-6 text-center text-sm text-muted-foreground">Nothing found.</Command.Empty>
        {forJob ? (
          <Command.Group heading={forJob.label} className={HEADING}>
            <Command.Item value="open" keywords={['Open the job']} onSelect={() => go(`#job/${encodeURIComponent(forJob.job!)}`)} data-slot="palette-action" data-act="open" className={ITEM}>Open the job</Command.Item>
            {actions.map((a) => (
              <Command.Item key={a.act} value={a.act} keywords={[a.label, a.act]} onSelect={() => runAction(forJob.job!, a)} data-slot="palette-action" data-act={a.act} className={ITEM}>
                <span className="min-w-0 flex-1 truncate">{armed === a.act ? `Press Enter again: ${a.label.toLowerCase()}` : a.label}</span>
                {!RUN_HERE[a.act] && a.act !== 'rerun' && <span className="shrink-0 text-[11px] text-muted-foreground">on the job</span>}
              </Command.Item>
            ))}
          </Command.Group>
        ) : (
          <>
            {q === '' && recent.length > 0 && <Command.Group heading="Recent" className={HEADING}>{recent.map((e) => item(e))}</Command.Group>}
            {PALETTE_GROUPS.filter((g) => g !== 'Recent').map((g) => {
              const local = entries.filter((e) => e.group === g);
              const remote = suggested.filter((e) => e.group === g);
              if (local.length + remote.length === 0) return null;
              // The index's suggestions matched already: they and their group show whatever cmdk's own match says.
              return <Command.Group key={g} heading={g} forceMount={remote.length > 0} className={HEADING}>{local.map((e) => item(e))}{remote.map((e) => item(e, true))}</Command.Group>;
            })}
            {q !== '' && (
              <Command.Item value="search-everything" forceMount onSelect={() => go(searchHash(emptySearch(q)))} data-slot="palette-search" className={ITEM}>
                <Search className="size-3.5 text-muted-foreground" aria-hidden />Search everything for “{q}”
              </Command.Item>
            )}
          </>
        )}
      </Command.List>
    </>
  );
}

const ITEM = cn('flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm data-[selected=true]:bg-muted');
const HEADING = '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-muted-foreground';
