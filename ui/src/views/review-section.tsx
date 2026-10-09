// A review section's view (issues #537, #543): Proposals and Research, one view built from the section's type, which
// the server declares (its parts and its decisions). What a job wrote instead of doing the work, apart from the
// questions — one card each, high-priority jobs' first, then the longest waiting. A card shows the newest version's
// parts and the parts it left out, earlier versions (a research report's rounds) folded, the review trail (each
// reviewer level's verdict and notes, and a person's decisions) and the job. A person decides on one waiting on them,
// or at any stage, with exactly the decisions the server takes: those that need notes are offered only with them; a
// research report's Dig deeper may name the open threads to go into. A session whose role cannot act (viewer) sees a
// notice. Shown, the ones waiting on a person are marked seen; the nav badge counts them until they are decided, seen
// or not. Below: the earlier ones, and for an admin the section's settings. Phase shifts (issue #548): an item says
// where it came from — a fork of another job's question, or a phase its job's question switched it to —, and Accept
// on one of a switched phase asks what the job does next, exactly the choices the server takes (`then`).
import { Check, ChevronRight, FileCheck, Lock, RotateCcw, Telescope, X, type LucideIcon } from 'lucide-react';
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
import { awaitsDecision, digDeeperNotes, openThreadsOf, partLabel, REVIEW_UI, reviewOrder } from '@/model/reviews';
import type { ReviewDecision, ReviewEntry, ReviewItemView, ReviewKind, ReviewSectionView, ReviewVersion, ShiftThen } from '@/model/wire';
import { goalOf } from '@/model/job';
import { actFor, useHopper } from '@/store';
import { refreshReviews } from '@/store/reviews';
import { useCanAdmin, useCanOperate, useJobIndex } from '@/store/selectors';
import { ReviewHistory, ReviewSettingsPanel } from './review-settings';

const ICON: Record<ReviewKind, LucideIcon> = { proposal: FileCheck, research: Telescope };

const VERDICT_TONE: Record<string, 'ok' | 'bad' | 'warn' | 'muted'> = {
  approve: 'ok', accept: 'ok', request_changes: 'warn', reject: 'bad', escalate: 'muted', dig_deeper: 'warn', steer: 'warn',
};
const VERDICT_LABEL: Record<string, string> = {
  approve: 'approve', accept: 'accepted', request_changes: 'changes requested', reject: 'rejected', escalate: 'escalate', dig_deeper: 'dig deeper', steer: 'steered',
};
const DECISION_ICON: Record<ReviewDecision['effect'], LucideIcon> = { accept: Check, send_back: RotateCcw, reject: X };
const THEN_LABEL: Record<ShiftThen, string> = { work: 'goes back to the work, with it as context', end: 'ends here', proposal: 'writes a proposal next, in the same session' };

/** Where an item came from (issue #548): a fork of another job's question, or a phase its own job's question switched it to. */
function Origin({ p }: { p: ReviewItemView }) {
  const jobs = useJobIndex();
  if (p.forkOf) {
    const parent = jobs.get(p.forkOf.jobId);
    return <div data-slot="origin" className="text-xs text-muted-foreground">Forked from a question of {parent ? goalOf(parent) : `job ${p.forkOf.jobId.slice(0, 8)}`}: its acceptance answers that question.</div>;
  }
  if (p.switchedFrom) return <div data-slot="origin" className="text-xs text-muted-foreground">Its job switched from its question to write this.</div>;
  return null;
}

function Version({ v, type }: { v: ReviewVersion; type: ReviewSectionView }) {
  const shown = type.parts.filter(([k]) => v.sections[k] !== undefined);
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
        <div data-slot="missing" className="text-xs text-warn">Left out: {v.missing.map((m) => partLabel(type, m)).join(', ')}</div>
      )}
    </div>
  );
}

function Review({ r }: { r: ReviewEntry }) {
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

function Decide({ kind, p, type }: { kind: ReviewKind; p: ReviewItemView; type: ReviewSectionView }) {
  const ui = REVIEW_UI[kind];
  const [notes, setNotes] = useState('');
  const [threads, setThreads] = useState<string[]>([]);
  const [then, setThen] = useState<ShiftThen>('work');
  const [busy, setBusy] = useState(false);
  // Set at once, before the re-render that disables the buttons: a second click in between sends nothing.
  const inFlight = useRef(false);
  const open = openThreadsOf(p.versions.at(-1)?.sections.openThreads);
  const digs = type.decisions.some((d) => d.id === 'dig_deeper');
  const decide = async (d: ReviewDecision) => {
    const text = d.id === 'dig_deeper' ? digDeeperNotes(threads, notes) : notes.trim();
    if (inFlight.current || (d.notes === 'required' && !text)) return;
    inFlight.current = true;
    setBusy(true);
    const picks = d.effect === 'accept' && p.then !== undefined;
    const r = await actFor(`/ui/api/${ui.section}/${encodeURIComponent(p.id)}/${d.route}`, { ...(text ? { notes: text } : {}), ...(picks ? { then } : {}) }, `${d.label}: done`);
    if (r.ok) { setNotes(''); setThreads([]); }
    inFlight.current = false;
    setBusy(false);
    refreshReviews(kind).catch(() => {});
  };
  const reason = notes.trim() !== '';
  const button = (d: ReviewDecision) => {
    const Icon = DECISION_ICON[d.effect];
    const needs = d.notes === 'required' && !reason;
    const b = (
      <Button key={d.id} data-decision={d.id} variant={d.effect === 'accept' ? 'default' : d.effect === 'reject' ? 'ghost' : 'outline'} disabled={busy || needs}
        title={needs ? 'Say why first' : undefined} onClick={d.effect === 'reject' ? undefined : () => void decide(d)}><Icon />{d.label}</Button>
    );
    if (d.effect !== 'reject') return b;
    return (
      <Confirm key={d.id} title={`${d.label} this ${ui.noun}?`} description="Its job ends, with the decision and your reason recorded." action={`${d.label} ${ui.noun}`} onConfirm={() => void decide(d)}>{b}</Confirm>
    );
  };
  return (
    <div className="space-y-2">
      {digs && open.length > 0 && (
        <fieldset data-slot="threads" className="grid gap-1 text-sm">
          <legend className="text-xs text-muted-foreground">Dig deeper on (none: the whole report)</legend>
          {open.map((t) => (
            <label key={t} className="flex items-center gap-2">
              <input type="checkbox" name={t} checked={threads.includes(t)} disabled={busy} onChange={() => setThreads((x) => (x.includes(t) ? x.filter((y) => y !== t) : [...x, t]))} />
              <span>{t}</span>
            </label>
          ))}
        </fieldset>
      )}
      {p.then && (
        <fieldset data-slot="then" className="grid gap-1 text-sm">
          <legend className="text-xs text-muted-foreground">Once accepted, the job</legend>
          {p.then.map((t) => (
            <label key={t} className="flex items-center gap-2">
              <input type="radio" name={`then-${p.id}`} value={t} checked={then === t} disabled={busy} onChange={() => setThen(t)} />
              <span>{THEN_LABEL[t]}</span>
            </label>
          ))}
        </fieldset>
      )}
      <Textarea rows={3} value={notes} disabled={busy} placeholder={kind === 'research' ? 'A note, what to dig into, or the direction to steer in' : 'A note with the acceptance, or the reason: what to change, or why it is rejected'}
        onChange={(e) => setNotes(e.target.value)} />
      <div className="flex flex-wrap gap-2">{type.decisions.map(button)}</div>
    </div>
  );
}

function ItemCard({ kind, p, type }: { kind: ReviewKind; p: ReviewItemView; type: ReviewSectionView }) {
  const ui = REVIEW_UI[kind];
  const job = useJobIndex().get(p.jobId);
  const role = useHopper((s) => s.user?.role);
  const canAct = useCanOperate();
  const latest = p.versions.at(-1)!;
  const earlier = p.versions.slice(0, -1);
  const human = p.stage === 'human';
  return (
    <Panel title={p.status === 'revising' ? ui.revising : human ? 'For you' : `With ${p.stage}`} icon={ICON[kind]}
      className={p.high ? 'border-warn/60' : human && p.status === 'open' ? 'border-question/40' : ''}
      action={<span className="num text-xs text-muted-foreground">version {latest.number} · {clock(latest.at)} <RaisedOn raisedBy={p.raisedBy} className="align-bottom" /></span>}
      bodyClassName="space-y-3">
      {!job && p.high && <HighTag priority={p.priority} className="self-start" />}
      {job ? <JobTitle job={job} /> : p.source?.title && <div className="text-sm font-medium">{p.source.title}</div>}
      <Origin p={p} />
      <Version v={latest} type={type} />
      {earlier.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />earlier versions ({earlier.length})
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 space-y-3">
            {earlier.map((v) => <div key={v.number} className="rounded-md border p-3"><div className="mb-2 text-xs text-muted-foreground">version {v.number}</div><Version v={v} type={type} /></div>)}
          </CollapsibleContent>
        </Collapsible>
      )}
      {p.reviews.length > 0 && (
        <div className="space-y-1.5"><div className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Review trail</div>{p.reviews.map((r, i) => <Review key={i} r={r} />)}</div>
      )}
      {p.status === 'open' && canAct && <Decide kind={kind} p={p} type={type} />}
      {p.status === 'revising' && <div className="text-sm text-muted-foreground">Sent back: its job is writing version {latest.number + 1}.</div>}
      {p.status === 'open' && !canAct && (
        <div data-slot="login-notice" className="flex flex-wrap items-center gap-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          <Lock className="size-4" />Your role ({role}) cannot decide on {ui.noun}s; an operator or admin can.
        </div>
      )}
    </Panel>
  );
}

/** The person has the items waiting on them in front of them: each is marked seen. Quiet: no toast. */
function useMarkSeen(kind: ReviewKind, ps: ReviewItemView[], canAct: boolean) {
  const unseen = ps.filter((p) => awaitsDecision(p) && !p.seenAt).map((p) => p.id).join(',');
  useEffect(() => {
    if (!canAct || !unseen) return;
    for (const id of unseen.split(',')) void actFor(`/ui/api/${REVIEW_UI[kind].section}/${encodeURIComponent(id)}/seen`, {});
  }, [kind, canAct, unseen]);
}

export function ReviewSection({ kind }: { kind: ReviewKind }) {
  const ui = REVIEW_UI[kind];
  const { items, decided, settings, type } = useHopper((s) => s.reviews[kind]);
  const ordered = useMemo(() => reviewOrder(items), [items]);
  const canAdmin = useCanAdmin();
  useMarkSeen(kind, items, useCanOperate());
  return (
    <div className="space-y-3">
      {ordered.length && type
        ? ordered.map((p) => <div key={p.id} data-item={p.id}><ItemCard kind={kind} p={p} type={type} /></div>)
        : <Panel title={ui.label} icon={ICON[kind]}><Empty>no open {ui.noun}s</Empty></Panel>}
      {decided.length > 0 && <ReviewHistory kind={kind} items={decided} type={type} />}
      {canAdmin && settings && <ReviewSettingsPanel kind={kind} settings={settings} />}
    </div>
  );
}

export const Proposals = () => <ReviewSection kind="proposal" />;
export const Research = () => <ReviewSection kind="research" />;
