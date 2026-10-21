// The one container every section uses: a card with a quiet uppercase title, a count, and an
// optional action on the right. It fills its grid cell, so the panels of one row line up. A list
// box (`list`) holds its list in a body of one height bound that scrolls past it (issue #84).
// On a long page (issue #2353): a sticky panel keeps its header, and the toolbar under it (its filters), in view below the
// app's header while its body scrolls with the page; a panel with `onToggle` folds, its title the toggle. A panel with
// `fold` folds by itself, open or folded kept per browser under that page choice key (`usage.accounts`).
import { ChevronDown, ChevronRight, type LucideIcon } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { useGroupOpen } from '@/hooks/use-page-pref';
import { cn } from '@/lib/utils';

export function Panel({ title, icon: Icon, count, action, toolbar, list, sticky, fold, open: openGiven = true, onToggle: toggleGiven, className, bodyClassName, children }: {
  title: string; icon?: LucideIcon; count?: React.ReactNode; action?: React.ReactNode; toolbar?: React.ReactNode; list?: boolean;
  sticky?: boolean; fold?: string; open?: boolean; onToggle?: () => void; className?: string; bodyClassName?: string; children: React.ReactNode;
}) {
  const [kept, toggleKept] = useGroupOpen(fold ?? '');
  const open = fold ? kept : openGiven;
  const onToggle = fold ? toggleKept : toggleGiven;
  const heading = <>
    {onToggle && (open ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />)}
    {Icon && <Icon className="size-3.5 shrink-0 text-muted-foreground" />}
    <h2 className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">{title}</h2>
    {count != null && count !== '' && <span className="num text-[11px] text-muted-foreground/70">{count}</span>}
  </>;
  return (
    // A sticky header needs a card that clips without scrolling: overflow-hidden would make the card its scroll box.
    <Card data-open={onToggle ? String(open) : undefined} className={cn('h-full gap-0 py-0', sticky ? 'overflow-clip' : 'overflow-hidden', className)}>
      <div data-slot="panel-header" data-sticky={sticky ? '' : undefined} className={cn(open && 'border-b', sticky && 'sticky top-14 z-20 bg-card')}>
        <div className="flex min-h-11 items-center gap-2 px-4 py-2">
          {onToggle
            ? <button type="button" data-slot="panel-toggle" aria-expanded={open} onClick={onToggle} className="-my-1 flex min-w-0 items-center gap-2 rounded py-1 text-left hover:bg-muted/40">{heading}</button>
            : heading}
          <div className="ml-auto flex items-center gap-2">{action}</div>
        </div>
        {open && toolbar}
      </div>
      {open && (
        <div data-slot="panel-body" data-list-box={list ? '' : undefined}
          className={cn('min-h-0 flex-1 p-4', list && 'max-h-96 overflow-y-auto overscroll-contain', bodyClassName)}>{children}</div>
      )}
    </Card>
  );
}

/** A page's section with a heading and a line under it (Sources' GitHub, GitLab): its heading folds it, kept as `fold`. */
export function FoldSection({ id, title, line, fold, children }: { id: string; title: string; line?: React.ReactNode; fold: string; children: React.ReactNode }) {
  const [open, toggle] = useGroupOpen(fold);
  return (
    <section data-open={String(open)} className="space-y-2" aria-labelledby={id}>
      <div>
        <button type="button" data-slot="panel-toggle" aria-expanded={open} onClick={toggle} className="-mx-1 flex items-center gap-1 rounded px-1 text-left hover:bg-muted/40">
          {open ? <ChevronDown className="size-3.5 text-muted-foreground" /> : <ChevronRight className="size-3.5 text-muted-foreground" />}
          <h2 id={id} className="text-sm font-semibold">{title}</h2>
        </button>
        {line}
      </div>
      {open && children}
    </section>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="py-6 text-center text-sm text-muted-foreground/70">{children}</div>;
}
