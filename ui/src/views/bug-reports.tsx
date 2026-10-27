// Your reports (issue #694), a top-level view (#reports; issue #897 moved it out of Settings, which keeps configuration only): each bug report the person filed with Report a bug, or one of their jobs
// filed, newest first, with its state — waiting for the person's approval (a job's report, with its text, Approve and
// Discard, issue #2818), waiting to send (kept while GitHub could not take it, with why), open or closed on GitHub, with
// its link; what the scrub removed before it was kept (issues #2812, #2818). The public warning, and the admin's switch
// for public bug reports, off by default (issue #2818). The hopper sends the kept ones and reads the states every 10
// minutes; Refresh does it now. Above the reports, the bug reports the completion reviews recommend (issue #2846 part 2).
import { Bug, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { filedBy, PUBLIC_REPORT_WARNING, removedLine, reportLine, sentLine, stateLabel, type BugReportAnswer, type BugReportView, type YourReports } from '@/model/bug-report';
import { useHopper } from '@/store';
import { useCanAdmin, useCanOperate } from '@/store/selectors';
import { RecommendedReports } from './recommended-reports';

const STATE_VARIANT: Record<BugReportView['state'], 'default' | 'secondary' | 'outline'> = { approval: 'outline', sending: 'outline', waiting: 'outline', open: 'default', closed: 'secondary' };

/** A refusal said as a toast: a session that ended signs out. */
const refused = (e: unknown, role: string) => {
  if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
  toast.error(e instanceof RoleRefused ? `Only ${role} does this` : (e as Error).message);
};

function Row({ r, canOperate, busy, act }: { r: BugReportView; canOperate: boolean; busy: boolean; act: (r: BugReportView, how: 'approve' | 'discard') => void }) {
  const by = filedBy(r);
  const removed = removedLine(r.removed);
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
      {removed && <p className="text-xs text-muted-foreground">{removed}</p>}
      {r.state === 'approval' && (
        <div data-slot="bug-report-approval" className="grid gap-2">
          <p className="text-xs">A job wrote this report. Read it: Approve posts it publicly on GitHub, as you; Discard drops it.</p>
          <pre className="max-h-64 overflow-auto rounded-md border p-2 text-xs whitespace-pre-wrap break-words">{r.body}</pre>
          {canOperate && (
            <div className="flex gap-2">
              <Button size="sm" disabled={busy} onClick={() => act(r, 'approve')}>Approve</Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => act(r, 'discard')}>Discard</Button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** Read when shown. */
export function BugReports() {
  const canOperate = useCanOperate();
  const canAdmin = useCanAdmin();
  const [view, setView] = useState<YourReports | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => get<YourReports>('/api/bug-reports').then((v) => { if (Array.isArray(v?.reports)) setView({ reports: v.reports, publicReports: v.publicReports === true }); }, () => {});
  useEffect(() => { void load(); }, []);
  const run = async (fn: () => Promise<void>, role: string) => {
    setBusy(true);
    try { await fn(); } catch (e) { refused(e, role); }
    setBusy(false);
  };
  const refresh = () => run(async () => {
    const v = await post<YourReports>('/ui/api/bug-reports/refresh', {});
    setView({ reports: v.reports, publicReports: v.publicReports === true });
  }, 'an operator or admin');
  const setPublic = (on: boolean) => run(async () => {
    const v = await post<{ publicReports: boolean }>('/ui/api/bug-reports/settings', { on });
    setView((x) => (x ? { ...x, publicReports: v.publicReports } : x));
    toast.success(on ? 'Public bug reports on' : 'Public bug reports off');
  }, 'an admin');
  const act = (r: BugReportView, how: 'approve' | 'discard') => void run(async () => {
    if (how === 'approve') {
      const a = await post<BugReportAnswer>('/ui/api/bug-reports/approve', { id: r.id });
      toast.success(a.kind === 'filed' || a.kind === 'commented' ? sentLine(a) : a.kind === 'kept' ? `Kept to send later: ${a.problem}` : 'Approved');
    } else {
      await post('/ui/api/bug-reports/discard', { id: r.id });
      toast.success('Report discarded');
    }
    await load();
  }, 'an operator or admin');
  const reports = view?.reports ?? null;
  return (
    <Panel title="Your reports" icon={Bug} className="max-w-3xl">
      <div data-slot="bug-reports" className="space-y-3">
        <p role="alert" data-slot="bug-reports-warning" className="rounded-md border border-destructive/50 p-2 text-sm font-medium">{PUBLIC_REPORT_WARNING}</p>
        {view && (
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={view.publicReports} disabled={busy || !canAdmin} aria-label="Public bug reports" onCheckedChange={(on) => void setPublic(on)} />
            {view.publicReports ? 'Public bug reports are on: Report a bug and your jobs\' approved reports post on GitHub.' : 'Public bug reports are off: nothing is posted. An admin turns them on.'}
          </label>
        )}
        <RecommendedReports canOperate={canOperate} busy={busy} run={run} done={load} />
        <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
          <p>The bug reports you or your jobs filed with Report a bug. A job's report waits for your approval. A report waits when GitHub cannot take it; the hopper sends it later.</p>
          {canOperate && <Button size="sm" variant="outline" disabled={busy} onClick={() => void refresh()}><RefreshCw />Refresh</Button>}
        </div>
        {reports === null
          ? <p className="text-sm text-muted-foreground">Loading…</p>
          : reports.length === 0
            ? <p className="text-sm text-muted-foreground">No reports yet. Report a bug is in the user menu, and on each failure, hand-off and question.</p>
            : <ul>{reports.map((r) => <Row key={r.id} r={r} canOperate={canOperate} busy={busy} act={act} />)}</ul>}
      </div>
    </Panel>
  );
}
