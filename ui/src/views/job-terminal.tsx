// The job's terminal on its job view (issue #1128): an operator opens a running job's herdr pane, sees its screen read
// again every 1.5 s, and types into it — text, or a key — through the hopper (POST /ui/api/jobs/:id/terminal/*), from
// anywhere the UI reaches. Access decides each use; the daemon audits the session and never keeps the text.
import { SquareTerminal, X } from 'lucide-react';
import { useState } from 'react';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { holdsPane } from '@/model/terminal';
import type { Job } from '@/model/wire';
import { useCanOperate } from '@/store/selectors';
import { PaneTerminal } from './pane-terminal';

export function JobTerminal({ job }: { job: Job }) {
  const operate = useCanOperate();
  const [open, setOpen] = useState(false);
  if (!operate || !holdsPane(job)) return null;
  return (
    <Panel title="Terminal" icon={SquareTerminal} bodyClassName="space-y-2">
      <div data-slot="job-terminal" className="space-y-2">
        {!open && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Button size="sm" variant="outline" onClick={() => setOpen(true)}><SquareTerminal />Open terminal</Button>
            <span>View the job&apos;s pane and type into it. What you type goes to the job&apos;s machine as you type it.</span>
          </div>
        )}
        {open && <PaneTerminal base={`/ui/api/jobs/${encodeURIComponent(job.id)}/terminal`}
          toolbar={<Button size="sm" variant="ghost" onClick={() => setOpen(false)}><X />Close</Button>} />}
      </div>
    </Panel>
  );
}
