// The views, routed by URL hash so a link (#questions) and the back button work.
import { Inbox, LayoutDashboard, ListTree, Menu, MessageCircleQuestion, Puzzle, Scale, Server, Webhook, type LucideIcon } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { useHopper } from '@/store';
import { cn } from '@/lib/utils';

export const VIEWS = ['overview', 'questions', 'decisions', 'events', 'sources', 'machines', 'plugins', 'webhooks'] as const;
export type View = (typeof VIEWS)[number];
const ITEMS: Record<View, { label: string; icon: LucideIcon }> = {
  overview: { label: 'Overview', icon: LayoutDashboard },
  questions: { label: 'Questions', icon: MessageCircleQuestion },
  decisions: { label: 'Decisions', icon: Scale },
  events: { label: 'Events', icon: ListTree },
  sources: { label: 'Sources', icon: Inbox },
  machines: { label: 'Machines', icon: Server },
  plugins: { label: 'Plugins', icon: Puzzle },
  webhooks: { label: 'Webhooks', icon: Webhook },
};

const subscribe = (fn: () => void) => { window.addEventListener('hashchange', fn); return () => window.removeEventListener('hashchange', fn); };
const read = (): View => { const h = window.location.hash.slice(1); return (VIEWS as readonly string[]).includes(h) ? (h as View) : 'overview'; };
export const useView = (): View => useSyncExternalStore(subscribe, read);

function Links({ view, onPick }: { view: View; onPick?: () => void }) {
  const questions = useHopper((s) => s.questions.length);
  const failedSources = useHopper((s) => s.sources.filter((x) => x.state === 'error').length);
  const badge: Partial<Record<View, { n: number; cls: string }>> = {
    questions: { n: questions, cls: 'bg-question text-background' }, sources: { n: failedSources, cls: 'bg-bad text-background' },
  };
  return (
    <nav className="grid gap-0.5">
      {VIEWS.map((v) => {
        const { label, icon: Icon } = ITEMS[v];
        const b = badge[v];
        return (
          <a key={v} href={`#${v}`} onClick={onPick} aria-current={view === v ? 'page' : undefined}
            className={cn('flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground',
              view === v && 'bg-muted text-foreground')}>
            <Icon className="size-4" />{label}
            {b && b.n > 0 && <span className={cn('num ml-auto grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-[11px] font-semibold', b.cls)}>{b.n}</span>}
          </a>
        );
      })}
    </nav>
  );
}

export function Sidebar({ view }: { view: View }) {
  return <aside className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-52 shrink-0 border-r p-3 lg:block"><Links view={view} /></aside>;
}

export function MobileNav({ view }: { view: View }) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild><Button variant="ghost" size="icon-sm" className="lg:hidden" aria-label="Open navigation"><Menu /></Button></SheetTrigger>
      <SheetContent side="left" className="w-64 p-3 pt-12">
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <Links view={view} onPick={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}

export const viewLabel = (v: View) => ITEMS[v].label;
