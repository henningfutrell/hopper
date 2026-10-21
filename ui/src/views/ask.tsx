// Ask hopper (issue #2375), one view (#ask) in place of Direct jobs and Direct queries: Run a job (#ask, a direct job,
// direct-jobs.tsx) and Ask a question (#ask/question, a direct query, direct-queries.tsx), as two tabs. The old links
// #direct-jobs and #direct-queries open the matching tab (nav.tsx MOVED).
import { useSection } from '@/app/nav';
import { cn } from '@/lib/utils';
import { DirectJobs } from '@/views/direct-jobs';
import { DirectQueries } from '@/views/direct-queries';

const TABS = [{ hash: '#ask', label: 'Run a job', section: '' }, { hash: '#ask/question', label: 'Ask a question', section: 'question' }] as const;

export function AskHopper() {
  const question = useSection() === 'question';
  return (
    <div className="space-y-3">
      <nav data-slot="ask-nav" aria-label="Ask hopper sections" className="flex gap-1">
        {TABS.map((t) => {
          const current = (t.section === 'question') === question;
          return (
            <a key={t.hash} href={t.hash} aria-current={current ? 'page' : undefined}
              className={cn('flex h-8 items-center rounded-md border px-3 text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground',
                current && 'border-foreground/20 bg-muted text-foreground')}>{t.label}</a>
          );
        })}
      </nav>
      {question ? <DirectQueries /> : <DirectJobs />}
    </div>
  );
}
