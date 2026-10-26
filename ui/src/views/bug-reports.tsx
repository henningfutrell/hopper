// Your reports (issue #694), a top-level view (#reports; issue #897 moved it out of Settings, which keeps configuration only): each bug report the person filed with Report a bug, or one of their jobs
// filed, newest first, with its state — waiting to send (kept while GitHub could not take it, with why), open or
// closed on GitHub, with its link; for a job's report, what of its private work was removed before it was sent (issue #2812). The hopper sends the kept ones and reads the states every 10 minutes; Refresh does
// it now.
import { Bug, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { filedBy, reportLine, stateLabel, type BugReportView } from '@/model/bug-report';
import { useHopper } from '@/store';
import { useCanOperate } from '@/store/selectors';

const STATE_VARIANT: Record<BugReportView['state'], 'default' | 'secondary' | 'outline'> = { sending: 'outline', waiting: 'outline', open: 'default', closed: 'secondary' };

function Row({ r }: { r: BugReportView }) {
  const by = filedBy(r);
  return (
    <li data-slot="bug-report-row" className="grid gap-1 border-b py-2 text-sm last:border-b-0">
      <div className="flex min-w-0 items-center justify-between gap-2">
        {r.url
          ? <a className="min-w-0 truncate underline" href={r.url} target="_blank" rel="noreferrer">{reportLine(r)}</a>
          : <span className="min-w-0 truncate">{reportLine(r)}</span>}
        <Badge variant={STATE_VARIANT[r.state]}>{stateLabel(r)}</Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        {new Date(r.createdAt).toLocaleString()}{by ? ` · ${by}` : ''}{r.kind === 'comment' ? ' · added to a similar report' : ''}
      </p>
      {r.state === 'waiting' && r.problem && <p className="text-xs text-muted-foreground">Not sent yet: {r.problem}</p>}
      {r.removed && r.removed.length > 0 && <p className="text-xs text-muted-foreground">Removed before sending, as private work: {r.removed.join(', ')}</p>}
    </li>
  );
}

/** Read when shown. */
export function BugReports() {
  const canOperate = useCanOperate();
  const [reports, setReports] = useState<BugReportView[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { get<{ reports: BugReportView[] }>('/api/bug-reports').then((v) => { if (Array.isArray(v?.reports)) setReports(v.reports); }, () => {}); }, []);
  const refresh = async () => {
    setBusy(true);
    try {
      setReports((await post<{ reports: BugReportView[] }>('/ui/api/bug-reports/refresh', {})).reports);
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only an operator or admin refreshes the reports' : (e as Error).message);
    }
    setBusy(false);
  };
  return (
    <Panel title="Your reports" icon={Bug} className="max-w-3xl">
      <div data-slot="bug-reports" className="space-y-3">
        <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
          <p>The bug reports you or your jobs filed with Report a bug. A report waits when GitHub cannot take it; the hopper sends it later.</p>
          {canOperate && <Button size="sm" variant="outline" disabled={busy} onClick={() => void refresh()}><RefreshCw />Refresh</Button>}
        </div>
        {reports === null
          ? <p className="text-sm text-muted-foreground">Loading…</p>
          : reports.length === 0
            ? <p className="text-sm text-muted-foreground">No reports yet. Report a bug is in the user menu, and on each failure, hand-off and question.</p>
            : <ul>{reports.map((r) => <Row key={r.id} r={r} />)}</ul>}
      </div>
    </Panel>
  );
}
