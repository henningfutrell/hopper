// The critical job tracker (issue #2203): a widget pinned under the header on every page, through navigation and reloads,
// while a critical job is tracked (model/critical-jobs.ts). Each job: its title and issue, its status, where it runs — its
// lane and its sandboxes —, its current step in plain words and for how long, and its last few actions. Each wait that is
// a person's has its action in place: a quick one (Grant, Let through, Approve, Continue) as a button, else the card of its
// one home opened under it — the question's, the run card's, the review item's, the hand-off's, the login's, the
// credential request's —, the same card on the same entry, so acting here or there clears both. A job that needs a person
// turns the widget red and pulses, and notifies the browser once per new wait when the person allowed notifications.
// Compact (issue #2261): one row per job — its title once, its state, for how long, its first wait's action —, opened in
// place by a click to show the rest, its last two actions with no title; the ended jobs folded behind their count; the
// panel a few rows high while no row is open. Its timeline links to its job page. An ended job stays until a person
// dismisses it.
import { Bell, ChevronRight, ExternalLink, Play, ShieldCheck, Siren, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { detailOf } from '@/components/event-line';
import { Since } from '@/components/job';
import { JobTimeline } from '@/components/job-timeline';
import { Dot, StatusBadge } from '@/components/status';
import { TextChangeCard } from '@/components/text-change';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { dismissNotice } from '@/hooks/use-dismissed';
import { get, post, SessionRejected } from '@/lib/api';
import { cn } from '@/lib/utils';
import { laneName } from '@/model/board';
import { hasEnded, trackerKey, waitKey, waitText, type TrackerWait } from '@/model/critical-jobs';
import { clock } from '@/model/format';
import { goalOf, issueRef, jobHref } from '@/model/job';
import type { DomainEvent, Job, JobBom, VaultView } from '@/model/wire';
import { act, useHopper } from '@/store';
import { useAttentionNotices, useCriticalJobs, type TrackedJob } from '@/store/critical-jobs';
import { useCanAdmin, useCanOperate, useJobName, useServerNow } from '@/store/selectors';
import { sendVault, useVault, useVaultStore, viewAnswer } from '@/store/vault';
import { GatePassButton } from '@/views/dashboard/queue';
import { HandoffRow } from '@/views/failures';
import { useJobBom } from '@/views/job-bom';
import { LoginCard } from '@/views/logins';
import { QuestionCard } from '@/views/questions';
import { ItemCard } from '@/views/review-section';
import { Waiting as RunCard } from '@/views/sandbox-approvals';
import { RequestItem } from '@/views/vault-requests';

/** The waits whose action is the card of their one home, opened under the wait. */
const OPENS: ReadonlySet<TrackerWait['kind']> = new Set(['question', 'run', 'credential', 'review', 'handoff', 'login', 'text-change']);

/** Grant the job the vault (issue #652), as Access requests' Grant. */
async function grantVault(jobId: string): Promise<void> {
  try {
    await viewAnswer(() => post<VaultView>(`/ui/api/jobs/${encodeURIComponent(jobId)}/grant-vault`, {}));
    toast.success(`job ${jobId.slice(0, 8)}: granted the vault`);
  } catch (e) {
    if (e instanceof SessionRejected) useHopper.setState({ authed: false });
    toast.error((e as Error).message);
  }
}

/** The card of a wait's one home: the same card as on its page, on the same entry. */
function HomeCard({ job, w }: { job: Job; w: TrackerWait }) {
  const vault = useVault();
  const admin = useCanAdmin();
  const busy = useVaultStore((s) => s.busy);
  const reviews = useHopper((s) => s.reviews);
  const loginSettings = useHopper((s) => s.loginSettings);
  const now = useServerNow();
  switch (w.kind) {
    case 'question': return <QuestionCard q={w.question} />;
    case 'run': return <ul><RunCard c={w.card} template={vault?.templates.find((t) => t.name === w.card.template)} asks={vault?.asks} secrets={vault?.secrets ?? []} can={admin} high={job.priority} /></ul>;
    case 'credential': return <ul><RequestItem r={w.request} can={admin} busy={busy} send={sendVault} /></ul>;
    case 'review': {
      const type = reviews[w.review].type;
      return type ? <ItemCard kind={w.review} p={w.item} type={type} /> : <a href={`#${w.review === 'proposal' ? 'proposals' : 'research'}`} className="text-xs underline">Open it in its section</a>;
    }
    case 'handoff': return <HandoffRow h={w.handoff} />;
    case 'login': return loginSettings ? <LoginCard l={w.login} now={now} settings={loginSettings} /> : <a href="#machines/logins" className="text-xs underline">Open it in Logins</a>;
    case 'text-change': return <TextChangeCard job={job} />;
    default: return null;
  }
}

/** A wait's quick action, a button or a link in place; none for a wait whose action opens its card. */
function QuickAction({ job, w }: { job: Job; w: TrackerWait }) {
  const operate = useCanOperate();
  const text = waitText(w);
  switch (w.kind) {
    case 'grant': return operate && <Button size="xs" onClick={() => void grantVault(job.id)}><ShieldCheck />Grant</Button>;
    case 'gate': return <GatePassButton job={job} />;
    case 'hold': return operate && <Button size="xs" onClick={() => act(`/ui/api/jobs/${job.id}/approve`, {}, 'Job approved')}><ShieldCheck />Approve</Button>;
    case 'wait': return operate && <Button size="xs" title="What it waits for has happened: it goes on in its pane, told so." onClick={() => act(`/ui/api/jobs/${job.id}/end-wait`, {}, 'Wait ended')}><Play />Continue</Button>;
    case 'accept': return <a href="#jobs/queue" className="text-xs text-warn hover:underline">{text.act} →</a>;
    case 'origin': return <a href="#intake" className="text-xs text-warn hover:underline">{text.act} →</a>;
    default: return null;
  }
}

/** One wait: what it is, and its action in place. `opened`: its card shows from the start. */
function WaitRow({ job, w, opened = false }: { job: Job; w: TrackerWait; opened?: boolean }) {
  const [open, setOpen] = useState(opened);
  const text = waitText(w);
  return (
    <li data-slot="critical-wait" data-wait={w.kind} className="space-y-2 rounded-md border border-bad/40 bg-bad/5 px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{text.what}</span>
        <QuickAction job={job} w={w} />
        {OPENS.has(w.kind) && (
          <Button size="xs" variant={open ? 'outline' : 'default'} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Close' : text.act}</Button>
        )}
      </div>
      {open && <div data-slot="critical-wait-card"><HomeCard job={job} w={w} /></div>}
    </li>
  );
}

/** The job's events, newest first: its parts list's and the ones the UI holds, each once. */
function useTimelineEvents(jobId: string, held: readonly DomainEvent[]): DomainEvent[] {
  const bom = useJobBom(jobId);
  const bySeq = new Map<number, DomainEvent>();
  for (const e of [...(bom?.events ?? []), ...held]) if (e.jobId === jobId) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => b.seq - a.seq);
}

const readEventsOf = (jobId: string) => get<JobBom>(`/api/jobs/${encodeURIComponent(jobId)}/bom`).then((b) => b.events);

/** Every step, sandbox run, command and result: read when it opens. */
function Timeline({ job }: { job: Job }) {
  const held = useHopper((s) => s.events);
  const events = useTimelineEvents(job.id, held);
  const machines = useHopper((s) => s.machines);
  const jobs = useHopper((s) => s.jobs);
  const nameOf = useJobName();
  return <JobTimeline job={job} events={events} nameOf={nameOf} machines={machines} statusOf={(id) => jobs[id]?.status} readEvents={readEventsOf} />;
}

/** One of the job's own events in plain words, with no title: the row names the job. */
const actionText = (e: DomainEvent): string => {
  const detail = detailOf(e);
  return detail ? `${e.type} — ${detail}` : e.type;
};

function ActionLine({ e }: { e: DomainEvent }) {
  return <li className="truncate"><span className="num text-muted-foreground/80" title={e.at}>{clock(e.at)}</span> {actionText(e)}</li>;
}

function TrackedRow({ t }: { t: TrackedJob }) {
  const { job, waits } = t;
  const machines = useHopper((s) => s.machines);
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState<string | undefined>();
  const ended = hasEnded(job);
  const needs = waits.length > 0;
  const first = waits[0];
  const ref = issueRef(job);
  return (
    <li data-slot="critical-job" data-job-id={job.id} data-needs-person={needs} data-expanded={open} className={cn('px-3 py-1', needs && 'bg-bad/5')}>
      <div className="flex min-h-7 items-center gap-2">
        <button type="button" data-slot="critical-row" aria-expanded={open} title={`${goalOf(job)}\njob ${job.id}`}
          className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => { setOpen(!open); setOpened(undefined); }}>
          <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} aria-hidden />
          <Dot tone={needs ? 'bad' : ended ? 'muted' : 'busy'} pulse={needs} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{goalOf(job)}</span>
          <StatusBadge status={job.status} />
          <Since iso={t.step.since} className="w-10 shrink-0 text-right text-xs text-muted-foreground" />
        </button>
        {first && !open && (OPENS.has(first.kind)
          ? <Button size="xs" onClick={() => { setOpen(true); setOpened(waitKey(job.id, first)); }}>{waitText(first).act}</Button>
          : <QuickAction job={job} w={first} />)}
        {ended && (
          <Button size="icon-xs" variant="ghost" aria-label="Dismiss" title="Dismiss: it no longer shows here" onClick={() => dismissNotice(trackerKey(job.id))}><X /></Button>
        )}
      </div>
      {open && (
        <div className="space-y-1.5 pt-1 pb-1 pl-6">
          <div data-slot="critical-where" className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
            {ref && <span className="font-mono">{ref}</span>}
            <span>{job.laneId ? laneName(job.laneId, machines) : 'no lane'}</span>
            {t.sandboxes.length > 0 && <span>sandbox {t.sandboxes.join(', ')}</span>}
          </div>
          <div data-slot="critical-step" className="text-sm [overflow-wrap:anywhere]">{t.step.text}</div>
          {t.actions.length > 0 && <ul data-slot="critical-actions" className="space-y-0.5 text-xs text-muted-foreground">{t.actions.map((e) => <ActionLine key={e.seq} e={e} />)}</ul>}
          {needs && <ul data-slot="critical-waits" className="space-y-1.5">{waits.map((w) => <WaitRow key={waitKey(job.id, w)} job={job} w={w} opened={opened === waitKey(job.id, w)} />)}</ul>}
          <Collapsible>
            <div className="flex items-center gap-3 text-xs">
              <CollapsibleTrigger className="group flex items-center gap-1 text-muted-foreground hover:text-foreground">
                <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />Timeline
              </CollapsibleTrigger>
              <a href={jobHref(job.id)} className="flex items-center gap-1 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">Job page<ExternalLink className="size-3" /></a>
            </div>
            <CollapsibleContent className="pt-2"><Timeline job={job} /></CollapsibleContent>
          </Collapsible>
        </div>
      )}
    </li>
  );
}

/** Turn on browser notifications: shown until the person allowed or refused them. */
function NotifyButton() {
  const [asked, setAsked] = useState(() => typeof Notification === 'undefined' || Notification.permission !== 'default');
  if (asked) return null;
  return (
    <Button size="xs" variant="ghost" title="A browser notification when a critical job needs you"
      onClick={() => { void Notification.requestPermission().finally(() => setAsked(true)); }}><Bell />Notify me</Button>
  );
}

export function CriticalTracker() {
  const tracked = useCriticalJobs(actionText);
  useAttentionNotices(tracked);
  const [showEnded, setShowEnded] = useState(false);
  if (!tracked.length) return null;
  const needs = tracked.filter((t) => t.waits.length > 0).length;
  const live = tracked.filter((t) => !hasEnded(t.job));
  const ended = tracked.length - live.length;
  const shown = showEnded ? tracked : live;
  return (
    <section data-slot="critical-tracker" data-needs-person={needs > 0} aria-label="Critical jobs"
      className={cn('sticky top-14 z-20 max-h-[min(50dvh,14rem)] overflow-y-auto overscroll-contain rounded-lg border bg-background shadow-md has-[[data-expanded=true]]:max-h-[50dvh]', needs ? 'border-bad ring-2 ring-bad/40' : 'border-warn/50')}>
      <div className={cn('sticky top-0 z-10 flex items-center gap-2 border-b bg-background px-3 py-1 text-sm font-medium', needs && 'text-bad')}>
        <Siren className={cn('size-4', needs && 'animate-pulse')} aria-hidden />
        Critical jobs <span className="num text-xs text-muted-foreground">{tracked.length}</span>
        {needs > 0 && <span data-slot="critical-needs" className="animate-pulse text-xs">{needs === 1 ? '1 needs you' : `${needs} need you`}</span>}
        <span className="ml-auto flex items-center gap-1">
          {ended > 0 && (
            <Button size="xs" variant="ghost" aria-pressed={showEnded} title={showEnded ? 'Hide the ended jobs' : 'Show the ended jobs'}
              onClick={() => setShowEnded(!showEnded)}>{`${ended} ended`}</Button>
          )}
          <NotifyButton />
        </span>
      </div>
      {shown.length > 0 && <ul className="divide-y">{shown.map((t) => <TrackedRow key={t.job.id} t={t} />)}</ul>}
    </section>
  );
}
