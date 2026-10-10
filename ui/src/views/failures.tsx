// Failures (issue #509): what the failure assessor made of the failed jobs. What is left first (issue #517): how
// many failed jobs are not assessed yet and how many need a person. Then Needs a person (issue #516) —
// every failed job automatic handling ended for whose hand-off is open, with its own count; each card first says what
// happened in one plain sentence, from the real state of the job's pull requests and issue (issue #621), then the
// recommended resolution as the main button with why, and a person resolves it there with a note (issue #551): Continue,
// Run again, Done, Won't do, each saying what it leads to, or why not now; the summary, the cause, the assessment and
// the raw error are behind Details. A resolved card says what was done, by whom, whether its issue was
// told, and links the job that follows; an admin names its cause from it —; then open problems — one shared cause,
// shown once with the jobs it hit and the ones held for it, with Resolve and Release held —; then the newest
// assessed failures still open (issues #529, #618), each with its decision, its summary and Retry; then Ended — the
// hand-offs closed and the failures that ended in the last day, history that waits on nobody (issue #618) —; then the
// profile and, for an admin, the settings. An action shows only when the daemon says it takes it now (`actions`) and the role may act; it
// updates live, read again on each assessor event. The assessment summary and a person's note are rendered as Markdown,
// sanitized (issue #569); the raw error stays as it was written.
import { Archive, History, OctagonAlert, Play, RotateCcw, CircleCheck, UserRound } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { JobTitle } from '@/components/job';
import { Markdown, TldrLine } from '@/components/markdown';
import { HighTag } from '@/components/priority';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { useNow } from '@/hooks/use-now';
import { ago } from '@/model/format';
import {
  DECISION_LABEL, DECISION_TONE, HANDOFF_REASON_LABEL, RESOLUTIONS, countsText, handoffEndText, offered, outcomeText, plural, resolutionLeadsTo, resolutionsFor, writeBackText,
} from '@/model/failures';
import type { FailureRecordView, HandoffResolutionAction, HandoffView, ProblemView } from '@/model/wire';
import { failureAct, useHopper } from '@/store';
import { useCanAdmin, useCanOperate, useJobIndex } from '@/store/selectors';
import { cn } from '@/lib/utils';
import { FailureProfilePanel, NameCause } from './failure-profile';
import { FailureSettingsPanel } from './failure-settings';

/** Where a problem applies, in words. */
function scopeText(p: ProblemView): string {
  const { machineId, executor } = p.scope;
  if (machineId && executor) return `${executor} on ${machineId}`;
  if (machineId) return `machine ${machineId}`;
  return executor ? `${executor} on every machine` : 'every machine';
}

/** A job no longer in the queue still says it is high priority, from its failure's or hand-off's tag (issue #535). */
function JobLine({ id, tag }: { id: string; tag?: { priority?: number; high?: boolean } }) {
  const job = useJobIndex().get(id);
  if (job) return <JobTitle job={job} />;
  return (
    <span className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">job {id.slice(0, 8)}
      {tag?.high && tag.priority !== undefined && <HighTag priority={tag.priority} />}</span>
  );
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

/** The job that follows a hand-off (issue #551): the same job continued, or the new one; where to watch it. */
function FollowedBy({ h }: { h: HandoffView }) {
  if (!h.nextJobId) return null;
  return (
    <div data-slot="next-job" className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>{h.nextJobId === h.jobId ? 'Goes on as' : 'Followed by'}</span>
      <JobLine id={h.nextJobId} />
      <a href="#queue" className="underline-offset-4 hover:underline">in Queue →</a>
    </div>
  );
}

/** What a person did about it, when, with their note and link, and whether its issue was told. */
function Resolution({ h }: { h: HandoffView }) {
  const now = useNow();
  const r = h.resolution;
  if (!r) return null;
  const told = writeBackText(r);
  return (
    <div data-slot="resolution" className="space-y-1 rounded bg-muted/40 px-2 py-1.5 text-xs">
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
        <span className="font-medium text-foreground">{handoffEndText(h)}</span>
        <span>by {r.by}</span>
        <span className="num" title={r.at}>{ago(r.at, now)}</span>
        {told && <span className={r.writeBack === 'written' ? '' : 'text-warn'}>{told}</span>}
      </div>
      {r.note && <Markdown text={r.note} />}
      {r.link && <a href={r.link} target="_blank" rel="noopener noreferrer" className="break-all underline underline-offset-4">{r.link}</a>}
    </div>
  );
}

/**
 * Resolve an open hand-off (issue #551): a note, a link for Done, and the resolutions — the card's recommended one as
 * the main button with why (issue #621), the others after it, each saying what it leads to. One the daemon refuses now
 * is said with its reason, never offered.
 */
function Resolve({ h }: { h: HandoffView }) {
  const [note, setNote] = useState('');
  const [link, setLink] = useState(h.card.link ?? '');
  const [busy, setBusy] = useState(false);
  const run = async (action: HandoffResolutionAction, label: string) => {
    setBusy(true);
    const body = { action, ...(note.trim() ? { note: note.trim() } : {}), ...(action === 'done_by_hand' && link.trim() ? { link: link.trim() } : {}) };
    if (await failureAct(`/ui/api/failures/handoffs/${encodeURIComponent(h.id)}/resolve`, body, label)) { setNote(''); setLink(''); }
    setBusy(false);
  };
  return (
    <div data-slot="resolve" className="space-y-2">
      <Textarea aria-label="Note" className="min-h-16 text-sm" placeholder="What did you do, or what should the job do next? Your note goes to the job and to its issue."
        value={note} onChange={(e) => setNote(e.target.value)} />
      {h.actions.doneByHand.ok && (
        <Input aria-label="Link" className="h-8 text-sm" placeholder="Link to the work, for Done (pull request or commit)" value={link} onChange={(e) => setLink(e.target.value)} />
      )}
      <ul className="space-y-1.5">
        {resolutionsFor(h).map(({ action, key, label }) => {
          const allowed = h.actions[key];
          const needsNote = action === 'wont_do' && note.trim() === '';
          const main = action === h.card.recommended;
          return (
            <li key={action} data-resolution={action} data-recommended={main ? '' : undefined} className={cn('flex flex-wrap items-center gap-2', main ? 'text-sm' : 'text-xs')}>
              {allowed.ok
                ? <Button size={main ? 'sm' : 'xs'} variant={main ? 'default' : 'outline'} disabled={busy || needsNote} title={needsNote ? 'Say why in the note first' : undefined}
                  onClick={() => void run(action, label)}>{label}</Button>
                : <span className="font-medium text-muted-foreground">{label}:</span>}
              <span className={main && allowed.ok ? 'text-foreground' : 'text-muted-foreground'}>
                {allowed.ok ? (main ? h.card.why : resolutionLeadsTo(action, h)) : `not now — ${allowed.why}`}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function HandoffRow({ h }: { h: HandoffView }) {
  const canAct = useCanOperate();
  const canAdmin = useCanAdmin();
  const now = useNow();
  const open = h.status === 'open';
  const recommended = RESOLUTIONS.find((r) => r.action === h.card.recommended)!;
  return (
    <li data-handoff={h.id} className={cn('space-y-2 px-4 py-3', !open && 'opacity-80')}>
      <div className="flex items-start gap-2">
        <JobLine id={h.jobId} tag={h} />
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <StatusBadge status={h.reason} tone={open ? 'question' : 'ok'} label={open ? HANDOFF_REASON_LABEL[h.reason] : handoffEndText(h)} />
        </span>
      </div>
      <div data-slot="what-happened" className="text-sm font-medium">{h.card.whatHappened}</div>
      {h.tldr && <TldrLine text={h.tldr.text} />}
      {open && canAct && <Resolve key={h.card.link ?? ''} h={h} />}
      {open && !canAct && (
        <div data-slot="recommended" className="text-sm text-muted-foreground"><span className="font-medium text-foreground">{recommended.label}: </span>{h.card.why}</div>
      )}
      <details data-slot="details" className="text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none">Details</summary>
        <div className="mt-1 space-y-1">
          <Markdown text={h.summary} />
          {h.causeName && <div>Known cause: {h.causeName}</div>}
          <ul className="list-disc space-y-0.5 pl-4">{h.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 font-mono">{h.error}</pre>
        </div>
      </details>
      <Resolution h={h} />
      <FollowedBy h={h} />
      {canAdmin && h.signature && !h.causeName && (
        <div data-slot="learn" className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>Seen this before? Name its cause and what to do next time; the assessor follows it.</span>
          <NameCause signature={h.signature} label="Name this cause" />
        </div>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="num" title={h.openedAt}>waiting since {ago(h.openedAt, now)}</span>
        {!open && h.closedAt && <span className="num" title={h.closedAt}>closed {ago(h.closedAt, now)}</span>}
        {h.causeName && <span>cause: {h.causeName}</span>}
      </div>
    </li>
  );
}

/** Needs a person: the open hand-offs only; a closed one is in Ended (issue #618). */
function NeedsAPerson({ handoffs }: { handoffs: HandoffView[] }) {
  const open = handoffs.filter((h) => h.status === 'open');
  const count = open.length > 0 ? <span data-slot="handoff-count" className="num grid h-5 min-w-5 place-items-center rounded-full bg-bad px-1.5 text-[11px] font-semibold text-background">{open.length}</span> : '';
  return (
    <div data-section="needs-a-person">
      <Panel title="Needs a person" icon={UserRound} count={count} list bodyClassName="p-0" className={open.length ? 'border-bad/40' : ''}>
        {open.length ? <ul className="divide-y">{open.map((h) => <HandoffRow key={h.id} h={h} />)}</ul> : <Empty>no job waits on a person</Empty>}
      </Panel>
    </div>
  );
}

/** Ended (issue #618): the hand-offs closed and the failures that ended in the last day. History: nothing waits on them. */
function Ended({ handoffs, failures }: { handoffs: HandoffView[]; failures: FailureRecordView[] }) {
  const closed = handoffs.filter((h) => h.status === 'closed');
  if (!closed.length && !failures.length) return null;
  return (
    <div data-section="ended">
      <Panel title="Ended in the last day" icon={Archive} count={closed.length + failures.length} list bodyClassName="p-0">
        <ul className="divide-y">
          {closed.map((h) => <HandoffRow key={h.id} h={h} />)}
          {failures.map((r) => <FailureRow key={r.id} r={r} />)}
        </ul>
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
        <JobLine id={r.jobId} tag={r} />
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <StatusBadge status={r.decision} tone={DECISION_TONE[r.decision]} label={DECISION_LABEL[r.decision]} title={r.reasons.join('\n')} />
          {offered(r.actions.retry, canAct) && <Button size="xs" variant="outline" disabled={busy} onClick={() => void retry()}><RotateCcw />Retry</Button>}
        </span>
      </div>
      <Markdown text={r.summary} className="text-sm" />
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
      <div data-section="open-failures">
        <Panel title="Recent failures" icon={History} count={failures.recent.length || ''} list bodyClassName="p-0">
          {failures.recent.length ? <ul className="divide-y">{failures.recent.map((r) => <FailureRow key={r.id} r={r} />)}</ul> : <Empty>no failure left to look at</Empty>}
        </Panel>
      </div>
      <Ended handoffs={failures.handoffs} failures={failures.ended} />
      {resolved.length > 0 && <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">{resolved.map((p) => <ProblemCard key={p.id} p={p} />)}</div>}
      <FailureProfilePanel view={failures} />
      {canAdmin && <FailureSettingsPanel settings={failures.settings} />}
    </div>
  );
}
