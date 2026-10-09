// Proposals (issue #537): what a job wrote instead of doing the work, apart from the questions — one card each,
// high-priority jobs' first, then the longest waiting. A card shows the newest version's parts and the parts it
// left out, earlier versions folded, the review trail (each reviewer level's verdict and notes, and a person's
// decisions) and the job. A person decides on one waiting on them, or at any stage: Accept (with an optional note),
// Request changes or Reject (each with a reason, which the job and the trail are told). A session whose role cannot
// act (viewer) sees a notice. Shown, the ones waiting on a person are marked seen; the nav badge counts them until
// they are decided, seen or not. Below: Earlier proposals, and for an admin the proposal settings.
import { Check, ChevronRight, FileCheck, Lock, RotateCcw, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Textarea } from '@/components/ui/textarea';
import { Confirm } from '@/components/confirm';
import { JobTitle } from '@/components/job';
import { HighTag } from '@/components/priority';
import { Empty, Panel } from '@/components/panel';
import { RaisedOn } from '@/components/raised-by';
import { StatusBadge } from '@/components/status';
import { between, clock } from '@/model/format';
import { awaitsDecision, proposalOrder, SECTIONS, sectionLabel } from '@/model/proposals';
import type { ProposalReview, ProposalVersion, ProposalView } from '@/model/wire';
import { actFor, useHopper } from '@/store';
import { refreshProposals } from '@/store/proposals';
import { useCanAdmin, useCanOperate, useJobIndex } from '@/store/selectors';
import { ProposalHistory, ProposalSettingsPanel } from './proposal-settings';

const VERDICT_TONE: Record<string, 'ok' | 'bad' | 'warn' | 'muted'> = {
  approve: 'ok', accept: 'ok', request_changes: 'warn', reject: 'bad', escalate: 'muted',
};
const VERDICT_LABEL: Record<string, string> = {
  approve: 'approve', accept: 'accepted', request_changes: 'changes requested', reject: 'rejected', escalate: 'escalate',
};

function Version({ v }: { v: ProposalVersion }) {
  const shown = SECTIONS.filter(([k]) => v.sections[k] !== undefined);
  return (
    <div className="space-y-2">
      {shown.length > 0 ? (
        <dl className="grid gap-2 text-sm">
          {shown.map(([k, label]) => (
            <div key={k} data-section={k} className="grid gap-0.5">
              <dt className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{label}</dt>
              <dd className="whitespace-pre-wrap">{v.sections[k]}</dd>
            </div>
          ))}
        </dl>
      ) : <pre className="rounded-md bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap">{v.text}</pre>}
      {v.missing.length > 0 && (
        <div data-slot="missing" className="text-xs text-warn">Left out: {v.missing.map(sectionLabel).join(', ')}</div>
      )}
    </div>
  );
}

function Review({ r }: { r: ProposalReview }) {
  return (
    <div className="space-y-1 border-l-2 border-border py-1 pl-3 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge status={r.stage} tone={r.role === 'human' ? 'question' : 'muted'} />
        {r.by && <span className="text-muted-foreground">{r.by}</span>}
        {r.model && <span className="font-mono text-muted-foreground">{r.model}</span>}
        <StatusBadge status={r.verdict} tone={VERDICT_TONE[r.verdict] ?? 'muted'} label={VERDICT_LABEL[r.verdict] ?? r.verdict} />
        <span className="text-muted-foreground">version {r.version}</span>
        <span className="num text-muted-foreground">{between(r.startedAt, r.finishedAt)}</span>
      </div>
      {r.notes && <div className="whitespace-pre-wrap">{r.notes}</div>}
      {r.error && <div className="text-bad">{r.error}</div>}
    </div>
  );
}

function Decide({ p }: { p: ProposalView }) {
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  // Set at once, before the re-render that disables the buttons: a second click in between sends nothing.
  const inFlight = useRef(false);
  const decide = async (how: 'accept' | 'reject' | 'request-changes', done: string) => {
    const text = notes.trim();
    if (inFlight.current || (how !== 'accept' && !text)) return;
    inFlight.current = true;
    setBusy(true);
    const r = await actFor(`/ui/api/proposals/${encodeURIComponent(p.id)}/${how}`, text ? { notes: text } : {}, done);
    if (r.ok) setNotes('');
    inFlight.current = false;
    setBusy(false);
    refreshProposals().catch(() => {});
  };
  const reason = notes.trim() !== '';
  return (
    <div className="space-y-2">
      <Textarea rows={3} value={notes} disabled={busy} placeholder="A note with the acceptance, or the reason: what to change, or why it is rejected"
        onChange={(e) => setNotes(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => void decide('accept', 'Proposal accepted')}><Check />Accept</Button>
        <Button variant="outline" disabled={busy || !reason} title={reason ? 'Send it back to the job with what to change' : 'Say what to change first'}
          onClick={() => void decide('request-changes', 'Sent back for changes')}><RotateCcw />Request changes</Button>
        <Confirm title="Reject this proposal?" description="Its job ends, with the rejection and your reason recorded." action="Reject proposal"
          onConfirm={() => void decide('reject', 'Proposal rejected')}>
          <Button variant="ghost" disabled={busy || !reason} title={reason ? 'Reject it, with your reason' : 'Say why first'}><X />Reject</Button>
        </Confirm>
      </div>
    </div>
  );
}

function ProposalCard({ p }: { p: ProposalView }) {
  const job = useJobIndex().get(p.jobId);
  const role = useHopper((s) => s.user?.role);
  const canAct = useCanOperate();
  const latest = p.versions.at(-1)!;
  const earlier = p.versions.slice(0, -1);
  const human = p.stage === 'human';
  return (
    <Panel title={p.status === 'revising' ? 'Being revised' : human ? 'For you' : `With ${p.stage}`} icon={FileCheck}
      className={p.high ? 'border-warn/60' : human && p.status === 'open' ? 'border-question/40' : ''}
      action={<span className="num text-xs text-muted-foreground">version {latest.number} · {clock(latest.at)} <RaisedOn raisedBy={p.raisedBy} className="align-bottom" /></span>}
      bodyClassName="space-y-3">
      {!job && p.high && <HighTag priority={p.priority} className="self-start" />}
      {job ? <JobTitle job={job} /> : p.source?.title && <div className="text-sm font-medium">{p.source.title}</div>}
      <Version v={latest} />
      {earlier.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />earlier versions ({earlier.length})
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 space-y-3">
            {earlier.map((v) => <div key={v.number} className="rounded-md border p-3"><div className="mb-2 text-xs text-muted-foreground">version {v.number}</div><Version v={v} /></div>)}
          </CollapsibleContent>
        </Collapsible>
      )}
      {p.reviews.length > 0 && (
        <div className="space-y-1.5"><div className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Review trail</div>{p.reviews.map((r, i) => <Review key={i} r={r} />)}</div>
      )}
      {p.status === 'open' && canAct && <Decide p={p} />}
      {p.status === 'revising' && <div className="text-sm text-muted-foreground">Sent back: its job is writing version {latest.number + 1}.</div>}
      {p.status === 'open' && !canAct && (
        <div data-slot="login-notice" className="flex flex-wrap items-center gap-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          <Lock className="size-4" />Your role ({role}) cannot decide on proposals; an operator or admin can.
        </div>
      )}
    </Panel>
  );
}

/** The person has the proposals waiting on them in front of them: each is marked seen. Quiet: no toast. */
function useMarkSeen(ps: ProposalView[], canAct: boolean) {
  const unseen = ps.filter((p) => awaitsDecision(p) && !p.seenAt).map((p) => p.id).join(',');
  useEffect(() => {
    if (!canAct || !unseen) return;
    for (const id of unseen.split(',')) void actFor(`/ui/api/proposals/${encodeURIComponent(id)}/seen`, {});
  }, [canAct, unseen]);
}

export function Proposals() {
  const proposals = useHopper((s) => s.proposals);
  const decided = useHopper((s) => s.decidedProposals);
  const settings = useHopper((s) => s.proposalSettings);
  const ordered = useMemo(() => proposalOrder(proposals), [proposals]);
  const canAdmin = useCanAdmin();
  useMarkSeen(proposals, useCanOperate());
  return (
    <div className="space-y-3">
      {ordered.length
        ? ordered.map((p) => <div key={p.id} data-proposal={p.id}><ProposalCard p={p} /></div>)
        : <Panel title="Proposals" icon={FileCheck}><Empty>no open proposals</Empty></Panel>}
      {decided.length > 0 && <ProposalHistory proposals={decided} />}
      {canAdmin && settings && <ProposalSettingsPanel settings={settings} />}
    </div>
  );
}
