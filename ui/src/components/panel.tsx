// The one container every section uses: a card with a quiet uppercase title, a count, and an
// optional action on the right. It fills its grid cell, so the panels of one row line up. A list
// box (`list`) holds its list in a body of one height bound that scrolls past it (issue #84).
import type { LucideIcon } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export function Panel({ title, icon: Icon, count, action, list, className, bodyClassName, children }: {
  title: string; icon?: LucideIcon; count?: React.ReactNode; action?: React.ReactNode; list?: boolean;
  className?: string; bodyClassName?: string; children: React.ReactNode;
}) {
  return (
    <Card className={cn('h-full gap-0 overflow-hidden py-0', className)}>
      <div className="flex min-h-11 items-center gap-2 border-b px-4 py-2">
        {Icon && <Icon className="size-3.5 text-muted-foreground" />}
        <h2 className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">{title}</h2>
        {count != null && count !== '' && <span className="num text-[11px] text-muted-foreground/70">{count}</span>}
        <div className="ml-auto flex items-center gap-2">{action}</div>
      </div>
      <div data-slot="panel-body" data-list-box={list ? '' : undefined}
        className={cn('min-h-0 flex-1 p-4', list && 'max-h-96 overflow-y-auto overscroll-contain', bodyClassName)}>{children}</div>
    </Card>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="py-6 text-center text-sm text-muted-foreground/70">{children}</div>;
}
