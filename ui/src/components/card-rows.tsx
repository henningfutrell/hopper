// Cards or Rows for a page of item cards (issue #2353): Questions, Proposals and Research. In Rows each item is one line,
// and a row opens its card in place, below it; which rows are open is not kept. The mode is a page choice, `<page>.mode`.
import { ChevronDown, ChevronRight, LayoutList, List } from 'lucide-react';
import { useState } from 'react';
import { ModeToggle, Pager, usePaged } from '@/components/pager';
import { usePagePref } from '@/hooks/use-page-pref';
import { cn } from '@/lib/utils';
import { CARDS_PER_PAGE, ROWS_PER_PAGE } from '@/model/page-prefs';

const MODES = [
  { mode: 'cards', label: 'Cards', icon: LayoutList, title: 'Each item whole, with its acts' },
  { mode: 'rows', label: 'Rows', icon: List, title: 'One line per item; a row opens its card' },
] as const;
export type CardMode = (typeof MODES)[number]['mode'];
const MODE_NAMES: readonly CardMode[] = MODES.map((m) => m.mode);

export const useCardMode = (page: string) => usePagePref<CardMode>(`${page}.mode`, 'cards', MODE_NAMES);

/** The Cards or Rows buttons of `page`; each is `<page>-mode-<mode>`. */
export function CardModeToggle({ page }: { page: string }) {
  const [mode, setMode] = useCardMode(page);
  return <ModeToggle slot={`${page}-mode`} value={mode} choices={MODES} onPick={setMode} />;
}

/** The first line of a text, for a row: Markdown marks left as they are. */
export const firstLine = (text: string) => text.trim().split('\n')[0] ?? '';

/** One item on one line: a button that opens its card below it. `facts` are the short ones on the right. */
export function CardRow({ slot, open, onOpen, high, label, text, facts }: {
  slot: string; open: boolean; onOpen: () => void; high?: boolean; label: string; text: string; facts?: React.ReactNode;
}) {
  return (
    <button type="button" data-slot={slot} aria-expanded={open} onClick={onOpen} title={text}
      className={cn('flex h-9 w-full min-w-0 items-center gap-2 rounded-md border bg-card px-3 text-left text-sm hover:bg-muted/40', high && 'border-warn/60')}>
      {open ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
      <span className="shrink-0 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">{label}</span>
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {facts && <span className="num hidden shrink-0 text-xs text-muted-foreground sm:inline">{facts}</span>}
    </button>
  );
}

/**
 * A page of `items` in the page's mode: 6 cards or 30 rows, and the pager. `reset` (a filter) goes back to the first page.
 * `render` draws one item: in Rows, `row` is its open state and toggle, else undefined.
 */
export function CardPage<T>({ page, items, id, reset, render }: {
  page: string; items: readonly T[]; id: (item: T) => string; reset?: string;
  render: (item: T, row?: { open: boolean; onOpen: () => void }) => React.ReactNode;
}) {
  const [mode] = useCardMode(page);
  const p = usePaged(items, mode === 'rows' ? ROWS_PER_PAGE : CARDS_PER_PAGE, `${mode}|${reset ?? ''}`);
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) => setOpened((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  return (
    <>
      {p.shown.map((item) => render(item, mode === 'rows' ? { open: opened.has(id(item)), onOpen: () => toggle(id(item)) } : undefined))}
      <Pager p={p} onPage={p.setPage} />
    </>
  );
}
