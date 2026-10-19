// Pending approvals (issue #2088, design.md "Pending approvals"): its own top-level page in Waiting on you — every GitHub
// Actions run that waits for a deployment approval the person can give, across the intake orgs, one row per run with its
// repository, workflow, title, environments, how long it has waited and a link to the run. A stale run (a newer one waits
// on the same repository and environment) is marked. Read-only: the person approves or rejects on GitHub, never here.
// The read is the shared one (store/polled.ts), so the nav count and the page agree.
import { AlertTriangle, ExternalLink, Rocket } from 'lucide-react';
import { Empty, Panel } from '@/components/panel';
import { useNow } from '@/hooks/use-now';
import { ago } from '@/model/format';
import { isPendingApprovalsView } from '@/model/pending-approvals';
import { usePendingApprovals } from '@/store/polled';
import type { PendingApproval, PendingApprovalsView } from '../../../src/domain/types.ts';

function Row({ a, now }: { a: PendingApproval; now: number }) {
  return (
    <li data-slot="pending-approval" className={a.stale ? 'space-y-1 py-2 opacity-70' : 'space-y-1 py-2'}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-medium break-all">{a.repo}</span>
        <span className="text-muted-foreground">{a.workflow}</span>
        {a.stale && <span data-slot="pending-approval-stale" className="rounded bg-muted px-1.5 text-[11px] text-muted-foreground" title="A newer run of this repository waits on the same environment">stale</span>}
        <a href={a.url} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs text-primary hover:underline">Open run<ExternalLink className="size-3" /></a>
      </div>
      <div className="break-words">{a.title}</div>
      <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
        <span>{a.environments.join(', ')}</span>
        <span data-slot="pending-approval-since" title={a.waitingSince}>waiting since {ago(a.waitingSince, now)}</span>
      </div>
    </li>
  );
}

function Content({ v }: { v: PendingApprovalsView }) {
  const now = useNow();
  return (
    <div className="space-y-3 text-sm">
      {v.approvals.length === 0
        ? (
          <div data-slot="pending-approvals-empty" className="space-y-2 py-4 text-center text-muted-foreground">
            <p className="font-medium text-foreground">Nothing waits on you.</p>
            <p className="mx-auto max-w-xl text-xs">
              This page lists each GitHub Actions run that waits for a deployment approval you can give — a terraform apply or a production
              promote, for example — in the repositories of the organizations your job repositories are in. The hopper reads them every 5
              minutes. It never approves or rejects a deployment: open the run on GitHub to do that.
            </p>
          </div>
        )
        : <ul data-slot="pending-approvals-list" className="divide-y">{v.approvals.map((a) => <Row key={`${a.repo} ${a.runId}`} a={a} now={now} />)}</ul>}
      {v.problems.length > 0 && (
        <div data-slot="pending-approvals-problems" className="space-y-1 rounded-md border border-warn/40 bg-warn/5 p-3 text-xs">
          <p className="flex items-center gap-1 font-medium"><AlertTriangle className="size-3.5" />GitHub did not show everything</p>
          <ul className="space-y-0.5">{v.problems.map((p) => <li key={p.where} className="break-words">{p.where}: {p.error}</li>)}</ul>
        </div>
      )}
      <p data-slot="pending-approvals-orgs" className="text-xs text-muted-foreground">
        {v.orgs.length === 0 ? 'No intake org: choose job repositories in Sources.' : `Intake orgs: ${v.orgs.join(', ')}.`}
        {' '}{v.reading ? 'Reading GitHub now.' : v.checkedAt ? `Read ${ago(v.checkedAt, now)}.` : 'Not read yet.'}
      </p>
    </div>
  );
}

export function PendingApprovals() {
  const v = usePendingApprovals();
  const ok = isPendingApprovalsView(v);
  return (
    <div data-slot="pending-approvals-page" className="max-w-4xl">
      <Panel title="Pending approvals" icon={Rocket} count={ok ? v.approvals.length : undefined}>
        {v === undefined ? <Empty>Loading pending approvals…</Empty> : ok ? <Content v={v} /> : <Empty>The pending approvals could not be read.</Empty>}
      </Panel>
    </div>
  );
}
