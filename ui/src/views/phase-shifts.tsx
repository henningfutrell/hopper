// Phase shifts (issue #548). On a question card: Research this and Propose this, each opening a small form — a note
// scoping the aspect, and Fork or Switch, the server's default chosen — and only the modes the server says the question
// takes; with none, why. A shift the job or a level suggested is one click, in the default mode. Below the questions,
// for an admin: the phase-shift settings — the default mode, what a parent does while its fork runs, and the
// escalation levels that may shift a job themselves.
// A fork shows on its question (issue #570): what it was asked for, its status and a link to its review or its job;
// while one runs, a second fork of its kind is not offered. A fork made from the card says so in its toast. A note is
// one line of inline Markdown, sanitized (issue #569).
import { FileCheck, GitFork, Lightbulb, Settings2, Telescope } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { InlineMarkdown } from '@/components/markdown';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { get, post, SessionRejected } from '@/lib/api';
import { REVIEW_UI } from '@/model/reviews';
import type { ForkParent, Job, PhaseShiftSettings, PhaseShiftSettingsView, QuestionFork, QuestionView, ReviewKind, ShiftMode } from '@/model/wire';
import { refreshLiveSoon, refreshQuestions, useHopper } from '@/store';
import { refreshReviewsSoon } from '@/store/reviews';

/** The route of each shift, its button and what one is called. */
const SHIFT: Record<ReviewKind, { path: string; label: string; verb: string; noun: string }> = {
  research: { path: 'research', label: 'Research this', verb: 'Research', noun: 'research' },
  proposal: { path: 'propose', label: 'Propose this', verb: 'Propose', noun: 'a proposal' },
};
const MODE: Record<ShiftMode, { label: string; help: (noun: string) => string }> = {
  fork: { label: 'Fork', help: (noun) => `a separate job does ${noun} about it; this job waits, and the accepted result answers its question` },
  switch: { label: 'Switch', help: (noun) => `this job, in its session, does ${noun} first; at Accept you pick whether it goes back to work` },
};

/** What each kind is called on its fork's line. */
const FORK_NAME: Record<ReviewKind, string> = { research: 'Research', proposal: 'Proposal' };
const ITEM_STATUS: Record<string, string> = { open: 'in review', revising: 'being revised', accepted: 'accepted', rejected: 'rejected', cancelled: 'cancelled' };
const JOB_STATUS: Record<string, string> = { waiting_answer: 'waiting on a question', queued: 'queued', running: 'running', held: 'held', parked: 'parked' };
/** Where a fork is looked at: its item's review, or, before it wrote one, its job in the queue. */
const forkLink = (kind: ReviewKind, itemId: string | undefined): string => (itemId ? `#${REVIEW_UI[kind].section}` : '#queue');

/** A fork made, the toast says so and links to it; the jobs and the review sections are read again. */
async function shift(q: QuestionView, to: ReviewKind, body: { mode?: ShiftMode; note?: string }): Promise<boolean> {
  try {
    const r = await post<{ fork?: Job }>(`/ui/api/questions/${encodeURIComponent(q.id)}/${SHIFT[to].path}`, body);
    if (r.fork) toast.success(`${FORK_NAME[to]} forked`, { description: <a href={forkLink(to, undefined)} className="underline">Open its job ({r.fork.id.slice(0, 8)})</a> });
    else toast.success(`${SHIFT[to].verb}: done`);
    refreshLiveSoon();
    refreshReviewsSoon(to);
    return true;
  } catch (e) {
    if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
    toast.error((e as Error).message);
    return false;
  } finally {
    refreshQuestions().catch(() => {});
  }
}

/** A running fork of the kind: a second fork of it is not offered. */
const forkRunning = (q: QuestionView, to: ReviewKind): boolean => (q.forks ?? []).some((f) => f.running && f.kind === to);

/** One fork of the question: what it was asked for, where it is, and a link to it. */
function ForkLine({ f, q }: { f: QuestionFork; q: QuestionView }) {
  const status = f.itemStatus ? ITEM_STATUS[f.itemStatus] ?? f.itemStatus : JOB_STATUS[f.jobStatus] ?? f.jobStatus;
  const head = f.running ? `${FORK_NAME[f.kind]} in progress` : `${FORK_NAME[f.kind]} ${status}`;
  const answeredWithout = f.running && q.status !== 'open' && q.answeredBy !== `fork:${f.jobId}`;
  return (
    <div data-slot="fork" data-fork={f.jobId} className="flex flex-wrap items-center gap-2 rounded-md border border-question/40 bg-question/5 p-2 text-sm">
      <GitFork className="size-4 text-question" />
      <span className="min-w-0 flex-1">{head}{f.note && <>: <InlineMarkdown text={f.note} /></>}{f.running && <span className="text-muted-foreground"> — {status}</span>}
        {answeredWithout && <span className="block text-xs text-muted-foreground">The question was answered while it ran; the fork was given the answer, and its result no longer goes to the job.</span>}
      </span>
      <a href={forkLink(f.kind, f.itemId)} className="text-xs underline">{f.itemId ? `Open the ${REVIEW_UI[f.kind].noun}` : `Open its job (${f.jobId.slice(0, 8)})`}</a>
    </div>
  );
}

/** The forks made from the question (issue #570), oldest first. */
export function QuestionForks({ q }: { q: QuestionView }) {
  if (!q.forks?.length) return null;
  return <div className="space-y-1.5">{q.forks.map((f) => <ForkLine key={f.jobId} f={f} q={q} />)}</div>;
}

function ShiftForm({ q, to, onDone }: { q: QuestionView; to: ReviewKind; onDone: () => void }) {
  const offered = q.shifts!;
  // A fork of this kind still runs: only a switch is offered (issue #570).
  const modes = offered.modes.filter((m) => m !== 'fork' || !forkRunning(q, to));
  const [mode, setMode] = useState<ShiftMode>(modes.includes(offered.defaultMode) ? offered.defaultMode : modes[0]!);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const send = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const text = note.trim();
    if (await shift(q, to, { mode, ...(text ? { note: text } : {}) })) onDone();
    inFlight.current = false;
    setBusy(false);
  };
  return (
    <div data-slot="shift-form" data-shift={to} className="space-y-2 rounded-md border p-3">
      <Textarea rows={2} value={note} disabled={busy} placeholder={`Optional: the aspect, e.g. ${to === 'research' ? '"research only the auth part"' : '"propose options for the schema"'}`}
        onChange={(e) => setNote(e.target.value)} />
      <fieldset className="grid gap-1 text-sm">
        <legend className="text-xs text-muted-foreground">How</legend>
        {modes.map((m) => (
          <label key={m} className="flex items-start gap-2">
            <input type="radio" name={`mode-${q.id}`} value={m} checked={mode === m} disabled={busy} onChange={() => setMode(m)} className="mt-1" />
            <span><span className="font-medium">{MODE[m].label}</span>{m === offered.defaultMode && <span className="text-muted-foreground"> (default)</span>}<span className="text-muted-foreground"> — {MODE[m].help(SHIFT[to].noun)}</span></span>
          </label>
        ))}
      </fieldset>
      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => void send()}>{mode === 'fork' ? <GitFork /> : to === 'research' ? <Telescope /> : <FileCheck />}{SHIFT[to].verb}</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}

/** Research this and Propose this, a suggestion as one click, or why the question offers no shift. */
export function ShiftActions({ q, busy }: { q: QuestionView; busy: boolean }) {
  const [open, setOpen] = useState<ReviewKind | null>(null);
  const [sending, setSending] = useState(false);
  const offered = q.shifts;
  if (!offered) return null;
  if (offered.modes.length === 0) {
    return offered.refusal ? <div data-slot="shift-refusal" className="text-xs text-muted-foreground">No research or proposal from here: {offered.refusal}.</div> : null;
  }
  const s = q.suggestion;
  const take = async () => {
    if (!s || sending) return;
    setSending(true);
    await shift(q, s.to, s.note ? { note: s.note } : {});
    setSending(false);
  };
  return (
    <div className="space-y-2">
      {s && !(offered.defaultMode === 'fork' && forkRunning(q, s.to)) && (
        <div data-slot="suggestion" className="flex flex-wrap items-center gap-2 rounded-md border border-question/40 bg-question/5 p-2 text-sm">
          <Lightbulb className="size-4 text-question" />
          <span className="min-w-0 flex-1">{s.by === 'job' ? 'the job suggests' : `${s.by} suggests`} {SHIFT[s.to].noun} first{s.note && <>: <InlineMarkdown text={s.note} /></>}</span>
          <Button size="sm" variant="outline" disabled={busy || sending} onClick={() => void take()} title={`${MODE[offered.defaultMode].label}: ${MODE[offered.defaultMode].help(SHIFT[s.to].noun)}`}>
            {SHIFT[s.to].verb} ({MODE[offered.defaultMode].label.toLowerCase()})
          </Button>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {(['research', 'proposal'] as const).map((k) => (
          <Button key={k} size="sm" variant={open === k ? 'secondary' : 'outline'} disabled={busy} onClick={() => setOpen(open === k ? null : k)}>
            {k === 'research' ? <Telescope /> : <FileCheck />}{SHIFT[k].label}
          </Button>
        ))}
      </div>
      {open && <ShiftForm key={open} q={q} to={open} onDone={() => setOpen(null)} />}
    </div>
  );
}

const FORK_PARENT_LABEL: Record<ForkParent, string> = { wait: 'waits on its question', park: 'is parked (where its executor can park)' };

function SettingsForm({ view, onSaved }: { view: PhaseShiftSettingsView; onSaved: (v: PhaseShiftSettingsView) => void }) {
  const [defaultMode, setDefaultMode] = useState<ShiftMode>(view.defaultMode);
  const [forkParent, setForkParent] = useState<ForkParent>(view.forkParent);
  const [levels, setLevels] = useState<string[]>(view.levels.filter((l) => view.choices.levels.includes(l)));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const body: PhaseShiftSettings = { defaultMode, forkParent, levels };
      onSaved(await post<PhaseShiftSettingsView>('/ui/api/phase-shifts', body));
      toast.success('Phase-shift settings saved');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error((e as Error).message);
    }
    setBusy(false);
  };
  return (
    <div data-slot="phase-shift-settings" className="space-y-3 text-sm">
      <fieldset className="grid gap-1">
        <legend className="text-xs text-muted-foreground">Default mode of Research this and Propose this</legend>
        {(['fork', 'switch'] as const).map((m) => (
          <label key={m} className="flex items-start gap-2">
            <input type="radio" name="defaultMode" value={m} checked={defaultMode === m} disabled={busy} onChange={() => setDefaultMode(m)} className="mt-1" />
            <span><span className="font-medium">{MODE[m].label}</span><span className="text-muted-foreground"> — {MODE[m].help('the research or the proposal')}</span></span>
          </label>
        ))}
      </fieldset>
      <fieldset className="grid gap-1">
        <legend className="text-xs text-muted-foreground">While its fork runs, the job</legend>
        {(['wait', 'park'] as const).map((p) => (
          <label key={p} className="flex items-center gap-2">
            <input type="radio" name="forkParent" value={p} checked={forkParent === p} disabled={busy} onChange={() => setForkParent(p)} />
            <span>{FORK_PARENT_LABEL[p]}</span>
          </label>
        ))}
      </fieldset>
      <fieldset className="grid gap-1">
        <legend className="text-xs text-muted-foreground">Escalation levels that shift a job themselves when they suggest it (none: only a person)</legend>
        {view.choices.levels.length === 0 && <span className="text-muted-foreground">No escalation levels are set up.</span>}
        {view.choices.levels.map((l) => (
          <label key={l} className="flex items-center gap-2">
            <input type="checkbox" name="level" value={l} checked={levels.includes(l)} disabled={busy}
              onChange={() => setLevels((x) => view.choices.levels.filter((y) => (y === l ? !x.includes(y) : x.includes(y))))} />
            <span className="font-mono">{l}</span>
          </label>
        ))}
      </fieldset>
      <Button size="sm" disabled={busy} onClick={() => void save()}>Save</Button>
    </div>
  );
}

/** For an admin, below the questions. Read when shown; keyed by the saved values, so a save starts the form from them. */
export function PhaseShiftSettingsPanel() {
  const [view, setView] = useState<PhaseShiftSettingsView | null>(null);
  // An answer without its settings is refused, never read as none.
  useEffect(() => { get<PhaseShiftSettingsView>('/api/phase-shifts').then((v) => { if (Array.isArray(v?.levels) && Array.isArray(v.choices?.levels)) setView(v); }, () => {}); }, []);
  if (!view) return null;
  return (
    <Panel title="Phase shifts" icon={Settings2}>
      <SettingsForm key={JSON.stringify(view)} view={view} onSaved={setView} />
    </Panel>
  );
}
