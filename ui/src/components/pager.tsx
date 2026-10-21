// Paging and modes for a long page (issue #2353): a list past one page shows a page of it, with Back and More and where
// it is ("1–30 of 250"); a page that shows cards also has a one-line mode. Which page is shown is not kept: a reload
// starts at the first. The mode is a page choice (hooks/use-page-pref.ts), kept per browser.
import { ChevronLeft, ChevronRight, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { pageOf, type Page } from '@/model/page-prefs';

export function Pager({ p, onPage, className }: { p: Page<unknown>; onPage: (page: number) => void; className?: string }) {
  if (p.pages <= 1) return null;
  return (
    <div data-slot="pager" className={cn('flex items-center justify-between gap-2 text-xs text-muted-foreground', className)}>
      <Button data-slot="pager-back" size="xs" variant="outline" disabled={p.page === 0} onClick={() => onPage(p.page - 1)}><ChevronLeft />Back</Button>
      <span data-slot="pager-range" className="num">{p.from}–{p.to} of {p.total}</span>
      <Button data-slot="pager-more" size="xs" variant="outline" disabled={p.page >= p.pages - 1} onClick={() => onPage(p.page + 1)}>More<ChevronRight /></Button>
    </div>
  );
}

/** A page of `items`, `size` to a page, and its pager; a new `reset` (a filter changed) goes back to the first page. */
export function usePaged<T>(items: readonly T[], size: number, reset?: string): Page<T> & { setPage: (page: number) => void } {
  const [at, setAt] = useState({ page: 0, reset });
  const page = at.reset === reset ? at.page : 0;
  const p = pageOf(items, page, size);
  return { ...p, setPage: (n: number) => setAt({ page: n, reset }) };
}

export interface ModeChoice<T extends string> { mode: T; label: string; icon: LucideIcon; title?: string }

/** The mode buttons: one pressed. Each is `<slot>-<mode>`. */
export function ModeToggle<T extends string>({ slot, value, choices, onPick }: { slot: string; value: T; choices: readonly ModeChoice<T>[]; onPick: (mode: T) => void }) {
  return (
    <div role="group" aria-label="View mode" className="inline-flex rounded-md border">
      {choices.map((c, i) => (
        <button key={c.mode} type="button" data-slot={`${slot}-${c.mode}`} aria-pressed={value === c.mode} title={c.title} onClick={() => onPick(c.mode)}
          className={cn('inline-flex items-center gap-1 px-2 py-1 text-xs', i > 0 && 'border-l', value === c.mode && 'bg-muted')}><c.icon className="size-3.5" />{c.label}</button>
      ))}
    </div>
  );
}
