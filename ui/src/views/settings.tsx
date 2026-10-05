// Settings (issue #151): the configuration plane, one view with a section per part — the question
// gates (escalation levels, standing rules, risk rules), the question history, routing, plugins and
// webhooks — each routed by hash (#settings/routing), so a link and the back button work. #settings
// alone opens the question gates.
import { History, Puzzle, Route, ShieldCheck, Webhook, type LucideIcon } from 'lucide-react';
import { useSection } from '@/app/nav';
import { cn } from '@/lib/utils';
import { Plugins } from '@/views/plugins';
import { QuestionGates } from '@/views/question-gates';
import { QuestionHistory } from '@/views/question-history';
import { Routing } from '@/views/routing';
import { Webhooks } from '@/views/webhooks';

const SECTIONS = ['questions', 'history', 'routing', 'plugins', 'webhooks'] as const;
type Section = (typeof SECTIONS)[number];
const ITEMS: Record<Section, { label: string; icon: LucideIcon; view: () => React.ReactNode }> = {
  questions: { label: 'Question gates', icon: ShieldCheck, view: QuestionGates },
  history: { label: 'Question history', icon: History, view: QuestionHistory },
  routing: { label: 'Routing', icon: Route, view: Routing },
  plugins: { label: 'Plugins', icon: Puzzle, view: Plugins },
  webhooks: { label: 'Webhooks', icon: Webhook, view: Webhooks },
};

const sectionOf = (s: string): Section => ((SECTIONS as readonly string[]).includes(s) ? (s as Section) : 'questions');

export function Settings() {
  const section = sectionOf(useSection());
  const Current = ITEMS[section].view;
  return (
    <div className="space-y-3">
      <nav data-slot="settings-nav" aria-label="Settings sections" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
        {SECTIONS.map((s) => {
          const { label, icon: Icon } = ITEMS[s];
          return (
            <a key={s} href={`#settings/${s}`} aria-current={section === s ? 'page' : undefined}
              className={cn('flex h-9 shrink-0 items-center gap-2 rounded-md border px-3 text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground',
                section === s && 'border-foreground/20 bg-muted text-foreground')}>
              <Icon className="size-4" />{label}
            </a>
          );
        })}
      </nav>
      <Current />
    </div>
  );
}
