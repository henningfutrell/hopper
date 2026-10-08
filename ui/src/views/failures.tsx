// Failures (issue #509): what the failure assessor made of the failed jobs. What is left first (issue #517): how
// many failed jobs are not assessed yet and how many need a person. Then Needs a person (issue #516) —
// every failed job automatic handling ended for, open until a person runs it again or clears it, with its own
// count —; then open problems — one shared cause,
// shown once with the jobs it hit and the ones held for it, with Resolve and Release held —; then the newest
// assessed failures, each with its decision, its summary and Retry; then the profile and, for an admin, the
// settings. An action shows only when the daemon says it takes it now (`actions`) and the role may act; it
// updates live, read again on each assessor event.
import { Check, History, OctagonAlert, Play, RotateCcw, CircleCheck, UserRound } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { JobTitle } from '@/components/job';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { useNow } from '@/hooks/use-now';
import { ago } from '@/model/format';
import { DECISION_LABEL, DECISION_TONE, HANDOFF_REASON_LABEL, countsText, handoffEndText, offered, outcomeText, plural } from '@/model/failures';
import type { FailureRecordView, HandoffView, ProblemView } from '@/model/wire';
import { failureAct, useHopper } from '@/store';
import { useCanAdmin, useCanOperate, useJobIndex } from '@/store/selectors';
import { cn } from '@/lib/utils';
import { FailureProfilePanel } from './failure-profile';
import { FailureSettingsPanel } from './failure-settings';

/** Where a problem applies, in words. */
function scopeText(p: ProblemView): string {
  const { machineId, executor } = p.scope;
  if (machineId && executor) return `${executor} on ${machineId}`;
  if (machineId) return `machine ${machineId}`;
  return executor ? `${executor} on every machine` : 'every machine';
}

function JobLine({ id }: { id: string }) {
  const job = useJobIndex().get(id);
  return job ? <JobTitle job={job} /> : <span className="font-mono text-xs text-muted-foreground">job {id.slice(0, 8)}</span>;
}

function ProblemCard({ p }: { p: ProblemView }) {
  const canAct = useCanOperate();
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const open = p.status === 'open';
  const run = async (what: 'resolve' | 'release', done: string) => {
    setBusy(true);
    await failureAct(`/ui/api/failures/problems/${encodeURIComponent(p.id)}/${what}`, {}, done);
    setBusy(false);
  };
  const effect = !open ? `Resolved ${p.resolvedBy === 'check' ? 'by its check' : 'by a person'} ${ago(p.resolvedAt, now)}.`
    : p.decision === 'redirect' ? 'New jobs it covers go to another machine; a job that cannot is held.' : 'New jobs it covers are held.';
  return (
    <div data-problem={p.id} className="min-w-0">
      <Panel title={p.title} icon={OctagonAlert} className={open ? 'border-bad/40' : ''} bodyClassName="space-y-2"
        action={<StatusBadge status={p.status} tone={open ? 'bad' : 'ok'} label={open ? (p.general ? 'open · recurring' : 'open') : 'resolved'} />}>
        <div className="text-sm text-muted-foreground">{effect}</div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="num">{plural(p.jobIds.length, 'job')}</span>
          <span className="num">{p.held.length} held</span>
          <span>on {scopeText(p)}</span>
          <span>since {ago(p.openedAt, now)}</span>
        </div>
        <ul className="space-y-1.5">{p.jobIds.slice(0, 8).map((id) => <li key={id}><JobLine id={id} /></li>)}</ul>
        {p.jobIds.length > 8 && <div className="text-xs text-muted-foreground">and {p.jobIds.length - 8} more</div>}
        {(offered(p.actions.resolve, canAct) || offered(p.actions.release, canAct)) && (
          <div className="flex flex-wrap gap-2 pt-1">
            {offered(p.actions.resolve, canAct) && <Button size="sm" disabled={busy} title="New jobs are no longer held for it; its held jobs run again" onClick={() => void run('resolve', 'Problem resolved')}><CircleCheck />Resolve</Button>}
            {offered(p.actions.release, canAct) && <Button size="sm" variant="outline" disabled={busy} title="Its held jobs run again now, through the normal queue" onClick={() => void run('release', 'Held jobs released')}><Play />Release held</Button>}
          </div>
        )}
      </Panel>
    </div>
  );
}

function HandoffRow({ h }: { h: HandoffView }) {
  const canAct = useCanOperate();
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const open = h.status === 'open';
  const run = async (what: 'run-again' | 'clear', done: string) => {
    setBusy(true);
    await failureAct(`/ui/api/failures/handoffs/${encodeURIComponent(h.id)}/${what}`, {}, done);
    setBusy(false);
  };
  return (
    <li data-handoff={h.id} className={cn('space-y-1.5 px-4 py-3', !open && 'opacity-70')}>
      <div className="flex items-start gap-2">
        <JobLine id={h.jobId} />
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <StatusBadge status={h.reason} tone={open ? 'question' : 'ok'} label={open ? HANDOFF_REASON_LABEL[h.reason] : handoffEndText(h)} />
          {offered(h.actions.runAgain, canAct) && <Button size="xs" variant="outline" disabled={busy} title="Its item runs again now: past its retry limit, past its problem's hold" onClick={() => void run('run-again', 'Running it again')}><RotateCcw />Run again</Button>}
          {offered(h.actions.clear, canAct) && <Button size="xs" variant="outline" disabled={busy} title="Acknowledged, no more work: it leaves Needs a person and the queue" onClick={() => void run('clear', 'Cleared')}><Check />Clear</Button>}
        </span>
      </div>
      <div className="text-sm">{h.summary}</div>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none">Assessment</summary>
        <ul className="mt-1 list-disc space-y-0.5 pl-4">{h.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 font-mono">{h.error}</pre>
      </details>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="num" title={h.openedAt}>waiting since {ago(h.openedAt, now)}</span>
        {!open && h.closedAt && <span className="num" title={h.closedAt}>closed {ago(h.closedAt, now)}</span>}
      </div>
    </li>
  );
}

function NeedsAPerson({ handoffs }: { handoffs: HandoffView[] }) {
  const open = handoffs.filter((h) => h.status === 'open').length;
  const count = open > 0 ? <span data-slot="handoff-count" className="num grid h-5 min-w-5 place-items-center rounded-full bg-bad px-1.5 text-[11px] font-semibold text-background">{open}</span> : '';
  return (
    <div data-section="needs-a-person">
      <Panel title="Needs a person" icon={UserRound} count={count} list bodyClassName="p-0" className={open ? 'border-bad/40' : ''}>
        {handoffs.length ? <ul className="divide-y">{handoffs.map((h) => <HandoffRow key={h.id} h={h} />)}</ul> : <Empty>no job waits on a person</Empty>}
      </Panel>
    </div>
  );
}

function FailureRow({ r }: { r: FailureRecordView }) {
  const canAct = useCanOperate();
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    setBusy(true);
    await failureAct(`/ui/api/failures/${encodeURIComponent(r.id)}/retry`, {}, 'Running it again');
    setBusy(false);
  };
  return (
    <li data-failure={r.id} className="space-y-1.5 px-4 py-3">
      <div className="flex items-start gap-2">
        <JobLine id={r.jobId} />
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <StatusBadge status={r.decision} tone={DECISION_TONE[r.decision]} label={DECISION_LABEL[r.decision]} title={r.reasons.join('\n')} />
          {offered(r.actions.retry, canAct) && <Button size="xs" variant="outline" disabled={busy} onClick={() => void retry()}><RotateCcw />Retry</Button>}
        </span>
      </div>
      <div className="text-sm">{r.summary}</div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {r.causeName && <span>{r.causeName}</span>}
        <span>{outcomeText(r)}</span>
        {r.note && <span title={r.note} className="max-w-full truncate">{r.note}</span>}
        <span className="num ml-auto" title={r.at}>{ago(r.at, now)}</span>
      </div>
    </li>
  );
}

export function Failures() {
  const failures = useHopper((s) => s.failures);
  const canAdmin = useCanAdmin();
  if (!failures) return <Panel title="Failures" icon={OctagonAlert}><Empty>failures not read yet</Empty></Panel>;
  const open = failures.problems.filter((p) => p.status === 'open');
  const resolved = failures.problems.filter((p) => p.status !== 'open');
  const left = failures.counts.unassessed + failures.counts.needsPerson;
  return (
    <div className="space-y-3">
      <div data-section="failure-counts" className={`text-sm ${left ? 'text-foreground' : 'text-muted-foreground'}`}>{countsText(failures.counts)}</div>
      <NeedsAPerson handoffs={failures.handoffs} />
      {open.length
        ? <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">{open.map((p) => <ProblemCard key={p.id} p={p} />)}</div>
        : <Panel title="Open problems" icon={OctagonAlert}><Empty>no open problem</Empty></Panel>}
      <Panel title="Recent failures" icon={History} count={failures.recent.length || ''} list bodyClassName="p-0">
        {failures.recent.length ? <ul className="divide-y">{failures.recent.map((r) => <FailureRow key={r.id} r={r} />)}</ul> : <Empty>no failure assessed yet</Empty>}
      </Panel>
      {resolved.length > 0 && <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">{resolved.map((p) => <ProblemCard key={p.id} p={p} />)}</div>}
      <FailureProfilePanel view={failures} />
      {canAdmin && <FailureSettingsPanel settings={failures.settings} />}
    </div>
  );
}
