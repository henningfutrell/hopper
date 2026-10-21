// A proposal as a set of paths (issue #651): its TL;DR and problem statement, then each path as its own sub-card —
// title and a recommended badge, its TL;DR as Markdown, its tradeoffs and other labelled fields as rows, what it creates
// (issue #755) — that expands to its full Markdown. A person
// checks one or more paths, adds a note to each, and continues with them; or asks for more paths (the selection goes
// along and is kept), steers, or rejects the whole proposal (issue #1659: always enabled, its note asked for in the
// dialog). Zero paths: the reason, and Accept, Ask for more paths, Steer and Reject.
// A path a reviewer level added says so; one it found not viable says why and cannot be checked. After the
// selection, each selected path links to its follow-on job with the job's live state, and the paths not selected are
// greyed out and kept. Built for a phone too: everything wraps, nothing scrolls sideways.
import { Check, ChevronRight, MessageSquare, Plus, Star, type LucideIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Markdown } from '@/components/markdown';
import { StatusBadge } from '@/components/status';
import { cn } from '@/lib/utils';
import type { PathPick, PathTradeoff, ProposalPath, ProposalPathSet, ReviewDecision, ReviewItemView, ReviewSectionView, ReviewVersion, ShiftThen } from '@/model/wire';
import { actFor } from '@/store';
import { refreshReviews } from '@/store/reviews';
import { useJobIndex } from '@/store/selectors';
import { RejectProposals } from './proposal-reject';

const TRADEOFFS: readonly [PathTradeoff, string][] = [['security', 'Security'], ['effort', 'Effort'], ['risk', 'Risk'], ['friction', 'Friction']];
const DECISION_ICON: Record<string, LucideIcon> = { accept: Check, more_paths: Plus, steer: MessageSquare };
const THEN_LABEL: Record<ShiftThen, string> = { work: 'goes back to the work, with it as context', end: 'ends here', proposal: 'writes a proposal next, in the same session' };

const pathsOfVersion = (v: ReviewVersion): ProposalPathSet => v.paths ?? { paths: [] };
const viable = (set: ProposalPathSet): ProposalPath[] => set.paths.filter((p) => !p.notViable);

/** The TL;DR and the problem statement; the recommendation and why; or, with no path, why none. */
export function ProblemStatement({ v }: { v: ReviewVersion }) {
  const set = pathsOfVersion(v);
  return (
    <div className="space-y-2">
      {v.sections.tldr && <div data-slot="tldr" className="text-sm font-medium"><Markdown text={v.sections.tldr} /></div>}
      {v.sections.problem && (
        <div data-slot="problem" className="grid gap-0.5">
          <div className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Problem</div>
          <Markdown text={v.sections.problem} />
        </div>
      )}
      {set.paths.length === 0 && (
        <div data-slot="no-paths" className="rounded-md border border-dashed p-3 text-sm">
          <div className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">No path</div>
          {set.none ?? 'The proposal gives no path and no reason.'}
        </div>
      )}
      {set.recommendation && (
        <div data-slot="recommendation" className="grid gap-0.5 text-sm">
          <div className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Recommended</div>
          <Markdown text={set.recommendation} />
        </div>
      )}
    </div>
  );
}

interface Pick { checked: boolean; note: string; disabled: boolean; onToggle(): void; onNote(note: string): void }

/** One path as a sub-card; with `pick`, a checkbox and, once checked, a note field. */
export function PathCard({ path, pick, faded, children }: { path: ProposalPath; pick?: Pick; faded?: boolean; children?: React.ReactNode }) {
  const blocked = Boolean(path.notViable);
  return (
    <div data-path={path.id} className={cn('min-w-0 space-y-2 rounded-md border p-3', pick?.checked && 'border-primary/60 bg-primary/5', faded && 'opacity-50', blocked && 'border-dashed')}>
      <div className="flex min-w-0 items-start gap-2">
        {pick && (
          <input type="checkbox" name={`path-${path.id}`} aria-label={`Select path ${path.id}: ${path.title}`} className="mt-1 size-4 shrink-0"
            checked={pick.checked} disabled={pick.disabled || blocked} onChange={pick.onToggle} />
        )}
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-xs text-muted-foreground">{path.id}</span>
            <span className="min-w-0 text-sm font-medium break-words">{path.title}</span>
            {path.recommended && (
              <span data-slot="recommended" className="inline-flex items-center gap-1 rounded border border-ok/40 px-1 text-[10px] text-ok"><Star className="size-3" />recommended</span>
            )}
            {path.addedBy && <span data-slot="added-by" className="rounded border px-1 text-[10px] text-muted-foreground">added by {path.addedBy}</span>}
          </div>
          {path.summary && <div data-slot="path-summary" className="text-sm"><Markdown text={path.summary} /></div>}
          {path.notViable && <div data-slot="not-viable" className="text-xs text-bad">Not viable ({path.notViable.by}): {path.notViable.why}</div>}
        </div>
      </div>
      <PathFields path={path} />
      {path.creates && (
        <div data-slot="path-creates" className="grid gap-0.5 border-t pt-2 text-xs">
          <div className="font-medium text-muted-foreground">Creates</div>
          <Markdown text={path.creates} />
        </div>
      )}
      {path.text && (
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />Details
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2"><div data-slot="path-text"><Markdown text={path.text} /></div></CollapsibleContent>
        </Collapsible>
      )}
      {pick?.checked && (
        <Input data-slot="path-note" aria-label={`A note for path ${path.id}`} placeholder="A note for this path (optional)" value={pick.note} disabled={pick.disabled}
          onChange={(e) => pick.onNote(e.target.value)} />
      )}
      {children}
    </div>
  );
}

/**
 * A path's tradeoffs, then the labelled fields the format does not name, one row each: the label, then its words as
 * Markdown. Rows line up from path to path, and the label column stays narrow on a phone.
 */
function PathFields({ path }: { path: ProposalPath }) {
  const rows: [string, string, string][] = [
    ...TRADEOFFS.flatMap(([t, label]): [string, string, string][] => (path.tradeoffs[t] ? [[t, label, path.tradeoffs[t]]] : [])),
    ...(path.otherFields ?? []).map((f): [string, string, string] => [f.label, f.label, f.text]),
  ];
  if (rows.length === 0) return null;
  return (
    <dl data-slot="path-fields" className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
      {rows.map(([key, label, text]) => (
        <div key={key} data-field={key} {...(TRADEOFFS.some(([t]) => t === key) ? { 'data-tradeoff': key } : {})} className="col-span-2 grid grid-cols-subgrid">
          <dt className="font-medium text-muted-foreground">{label}</dt>
          <dd className="min-w-0"><Markdown text={text} /></dd>
        </div>
      ))}
    </dl>
  );
}

/** A version's paths, read only: an earlier version, or one a person cannot decide on. */
export function PathsView({ v }: { v: ReviewVersion }) {
  return (
    <div className="space-y-2">
      <ProblemStatement v={v} />
      {pathsOfVersion(v).paths.map((p) => <PathCard key={p.id} path={p} />)}
    </div>
  );
}

/** The selection form: the newest version's paths with a checkbox each, and the section's decisions. */
export function PathsDecide({ p, type }: { p: ReviewItemView; type: ReviewSectionView }) {
  const v = p.versions.at(-1)!;
  const set = pathsOfVersion(v);
  const open = viable(set);
  const kept = new Map((p.selection?.paths ?? []).filter((x) => open.some((o) => o.id === x.id)).map((x) => [x.id, x.note ?? '']));
  const [picks, setPicks] = useState<Map<string, string>>(kept);
  const [notes, setNotes] = useState('');
  const [then, setThen] = useState<ShiftThen>('work');
  const [busy, setBusy] = useState(false);
  // Set at once, before the re-render that disables the buttons: a second click in between sends nothing.
  const inFlight = useRef(false);
  const chosen = (): PathPick[] => set.paths.filter((x) => picks.has(x.id)).map((x) => ({ id: x.id, ...(picks.get(x.id)!.trim() ? { note: picks.get(x.id)!.trim() } : {}) }));
  const decide = async (d: ReviewDecision) => {
    const text = notes.trim();
    if (inFlight.current || (d.notes === 'required' && !text)) return;
    inFlight.current = true;
    setBusy(true);
    const paths = d.effect === 'accept' && open.length === 0 ? [] : chosen();
    const body = { ...(text ? { notes: text } : {}), ...(paths.length > 0 ? { paths } : {}), ...(d.effect === 'accept' && p.then !== undefined ? { then } : {}) };
    const r = await actFor(`/ui/api/proposals/${encodeURIComponent(p.id)}/${d.route}`, body, `${d.label}: done`);
    if (r.ok) { setNotes(''); setPicks(new Map()); }
    inFlight.current = false;
    setBusy(false);
    refreshReviews('proposal').catch(() => {});
  };
  const toggle = (id: string) => setPicks((m) => { const n = new Map(m); if (n.has(id)) n.delete(id); else n.set(id, ''); return n; });
  const note = (id: string, text: string) => setPicks((m) => new Map(m).set(id, text));
  // Zero paths: Accept agrees no change is needed. Reject (issue #1659) rejects the whole proposal, with its own dialog.
  const button = (d: ReviewDecision) => {
    if (d.effect === 'reject') return <RejectProposals key={d.id} ids={[p.id]} label={d.label} />;
    const Icon = DECISION_ICON[d.id] ?? Check;
    const label = d.effect === 'accept' && open.length === 0 ? 'Accept' : d.label;
    const needs = d.notes === 'required' && !notes.trim();
    const none = d.effect === 'accept' && open.length > 0 && picks.size === 0;
    return (
      <Button key={d.id} data-decision={d.id} variant={d.effect === 'accept' ? 'default' : 'outline'} disabled={busy || needs || none}
        title={needs ? 'Write a note first' : none ? 'Select at least one path' : undefined} onClick={() => void decide(d)}><Icon />{label}</Button>
    );
  };
  return (
    <div className="space-y-3">
      <ProblemStatement v={v} />
      {set.paths.map((x) => (
        <PathCard key={x.id} path={x} pick={{ checked: picks.has(x.id), note: picks.get(x.id) ?? '', disabled: busy, onToggle: () => toggle(x.id), onNote: (t) => note(x.id, t) }} />
      ))}
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
      <Textarea rows={3} value={notes} disabled={busy} placeholder="A note: with the decision, or what to steer toward" onChange={(e) => setNotes(e.target.value)} />
      <div className="flex flex-wrap gap-2">{type.decisions.map(button)}</div>
    </div>
  );
}

/** After the selection: every path of the version signed off, each selected one with its follow-on and its live state. */
export function FollowOns({ p }: { p: ReviewItemView }) {
  const jobs = useJobIndex();
  const selected = p.signOff?.selected;
  if (!selected?.length) return null;
  const v = p.versions[p.signOff!.version - 1] ?? p.versions.at(-1)!;
  const paths = pathsOfVersion(v).paths;
  const statusOf = (jobId: string): string => jobs.get(jobId)?.status ?? p.followOns?.find((f) => f.jobId === jobId)?.jobStatus ?? 'missing';
  return (
    <ul data-slot="follow-ons" className="grid w-full gap-1 text-xs">
      {paths.map((x) => {
        const pick = selected.find((s) => s.id === x.id);
        return (
          <li key={x.id} data-path={x.id} data-selected={pick ? 'true' : 'false'} className={cn('flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5', !pick && 'opacity-50')}>
            <span className="font-mono text-muted-foreground">{x.id}</span>
            <span className={cn('min-w-0 break-words', !pick && 'line-through')}>{x.title}</span>
            {pick?.jobId && (
              <>
                <a href="#jobs/queue" className="font-mono underline-offset-4 hover:underline">job {pick.jobId.slice(0, 8)}</a>
                <span data-slot="follow-on-status"><StatusBadge status={statusOf(pick.jobId)} /></span>
              </>
            )}
            {pick?.note && <span className="text-muted-foreground">note: {pick.note}</span>}
          </li>
        );
      })}
    </ul>
  );
}
