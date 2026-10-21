// A merged page (issue #2374): one nav entry whose tabs filter one workflow, each tab the view it was before the merge.
// The hash names the tab (#approvals/pending-approvals), so a link and the back button work; with none, the first. Each
// tab shows its own badge; the nav entry shows their sum.
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Count, useNavBadges } from './nav';
import { PAGE_TABS, tabOf, useSection, type MergedPage, type Tab } from './routes';

export function PageTabs({ page, views }: { page: MergedPage; views: Partial<Record<Tab, () => ReactNode>> }) {
  const tab = tabOf(page, useSection());
  const badges = useNavBadges().tabs;
  const Current = views[tab]!;
  return (
    <div className="space-y-3">
      <nav data-slot="page-tabs" aria-label="Tabs" className="flex flex-wrap gap-1 border-b">
        {PAGE_TABS[page].map((t) => {
          const b = badges[t.id];
          return (
            <a key={t.id} href={`#${page}/${t.id}`} aria-current={t.id === tab ? 'page' : undefined}
              className={cn('-mb-px flex h-9 items-center gap-2 border-b-2 border-transparent px-3 text-sm text-muted-foreground transition-colors hover:text-foreground',
                t.id === tab && 'border-foreground text-foreground')}>
              {t.label}
              {b && b.n > 0 && <Count slot="tab-badge" b={b} />}
            </a>
          );
        })}
      </nav>
      <Current />
    </div>
  );
}
