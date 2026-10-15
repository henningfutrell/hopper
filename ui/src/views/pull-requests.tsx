// Pull requests (issue #637): every hopper pull request that waits — a done job's, followed after its end, or one closed
// without a merge — grouped per job repository, with the repository's yolo mode and a link to its one switch in Settings →
// Yolo mode (issue #897). The header says how many repositories have yolo mode on, where merging waits, and how many have
// merge conflicts (issue #897; the nav badge counts them too). Read from
// `GET /api/pull-requests`, again every few seconds and after a change. An open card has Merge now and Close PR for an
// operator (issue #677), each confirmed once, and Send back for rework (issue #724): with notes, the pull request becomes
// a draft and a new job reworks it. A repository with no checks (issue #677, `GET /api/repo-checks`) is named in the
// header and warned of in its group, with the job that adds them: Queue job files it at once, Dismiss hides it.
// A card the hopper gave up on (its tend job ended failed, cancelled or rejected) has Tend again (issue #1010).
// Landing (issue #1073): the job pull requests merged into the landing branch, each with its batch stage, until a batch run
// moves it to the tested branch. Not tracked (issue #1176): each open pull request of a job repository the hopper does not
// track, with why; one whose issue is not in Intake has Take into Intake, which shows its GitHub write on the row (issue #1194).
// Each card shows its change kind (issue #1076), why in its title. A card with a pull request, and a landing card — a batch's
// culprit among them —, opens its diff in a code block (issue #1169).
import { ExternalLink, GitBranch, GitMerge, GitPullRequest, Inbox, Loader2, RotateCw, TriangleAlert, Undo2, X } from 'lucide-react';
import { useCallback, useState } from 'react';
import { GhLink } from '@/components/job';
import { Confirm } from '@/components/confirm';
import { PullRequestDiff } from '@/components/pull-request-diff';
import { Empty, Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { StatusBadge, YoloBadge, type Tone } from '@/components/status';
import { Textarea } from '@/components/ui/textarea';
import { usePoll } from '@/hooks/use-poll';
import { useNow } from '@/hooks/use-now';
import { get } from '@/lib/api';
import { ago } from '@/model/format';
import { CHANGE_KIND_TEXT, MERGEABLE_TEXT, changeWhy, checksText, closeQuestion, closesText, conflictedPullRequests, doingText, conflictsLine, landingText, mergeQuestion, hasCards, noChecksLine, noChecksNote, untrackedText, waitingLine, waitsText, yoloLine, yoloNote } from '@/model/pull-requests';
import type { LandingCard, PullRequestCard, PullRequestsView, RepoChecks, RepoChecksView, UntrackedPullRequest } from '@/model/wire';
import { act, actFor } from '@/store';
import { intakeRefusal } from '@/store/intake';
import { giveBack, PENDING, useGivingBack } from '@/store/give-back';
import { ACTING, actOnPullRequest, useActingOnPullRequest, type PullRequestAct } from '@/store/pull-request-acts';
import { setPolled } from '@/store/polled';
import { useCanOperate } from '@/store/selectors';

const POLL_MS = 10_000;

const STATE_TONE: Record<PullRequestCard['state'], Tone> = { open: 'busy', merged: 'ok', closed: 'bad' };
const CHECKS_TONE: Record<PullRequestCard['checks'], string> = { passing: 'text-ok', pending: 'text-warn', failing: 'text-bad', none: '', unknown: '' };

/**
 * Merge now and Close PR (issue #677), and Send back for rework (issue #724): an open card with a pull request, for an
 * operator. Rework's notes say what to change; they go to the new job, never to GitHub.
 */
function CardActions({ c, onChanged }: { c: PullRequestCard; onChanged: () => void }) {
  const operator = useCanOperate();
  const [busy, setBusy] = useState(false);
  const [reworking, setReworking] = useState(false);
  const [notes, setNotes] = useState('');
  const sendingBack = useGivingBack((s) => s[c.jobId] === 'rework');
  const acting = useActingOnPullRequest((s) => s[c.jobId]);
  // A tend job works on it (issue #763): its job follows it no more, so no act until the tend job ends.
  if (!operator || c.state !== 'open' || !c.pullRequest || c.tendJobId) return null;
  // Answered at once (issue #1194): GitHub merges or closes it after, and the card waits until the stream says so.
  const run = (what: PullRequestAct) => void actOnPullRequest(c.jobId, what, onChanged);
  const waiting = busy || acting !== undefined;
  // Answered at once (issue #1194): the pull request is made a draft after, and the card waits until the stream says so.
  const rework = async () => {
    setBusy(true);
    const ok = await giveBack(c.jobId, 'rework', { body: { notes: notes.trim() }, ended: onChanged });
    setBusy(false);
    if (ok) { setReworking(false); setNotes(''); onChanged(); }
  };
  return (
    <div className="space-y-2 pt-1">
      <div data-slot="pr-actions" className="flex flex-wrap gap-2">
        <Confirm title={mergeQuestion(c)} action="Merge" onConfirm={() => run('merge')}
          description="The hopper merges it now with a merge commit, whatever yolo mode and its checks say. GitHub still refuses a draft, merge conflicts or a required check.">
          <Button size="sm" variant="outline" disabled={waiting}><GitMerge />{acting === 'merge' ? ACTING.merge : 'Merge now'}</Button>
        </Confirm>
        <Button data-slot="pr-rework" size="sm" variant="outline" disabled={waiting || reworking || sendingBack} title="Make it a draft, and a new job reworks it with your notes"
          onClick={() => setReworking(true)}><Undo2 />{sendingBack ? 'Sending back' : 'Send back for rework'}</Button>
        <Confirm title={closeQuestion(c)} action="Close PR" onConfirm={() => run('close')}
          description="The pull request closes without a merge. Its issue gets hopper:pr-closed and is not taken again until a person removes the label.">
          <Button size="sm" variant="ghost" disabled={waiting}><X />{acting === 'close' ? ACTING.close : 'Close PR'}</Button>
        </Confirm>
      </div>
      {reworking && <>
        <Textarea data-slot="pr-rework-notes" aria-label="Rework notes" className="min-h-16 text-sm" maxLength={8000}
          placeholder="What should change? The new job is told your notes. The pull request becomes a draft until it is reworked."
          value={notes} onChange={(e) => setNotes(e.target.value)} />
        <div className="flex gap-2">
          <Button data-slot="pr-rework-send" size="xs" disabled={busy || notes.trim() === ''} onClick={() => void rework()}>Send back</Button>
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => setReworking(false)}>Cancel</Button>
        </div>
      </>}
    </div>
  );
}

/**
 * Tend again (issue #1010): the hopper gave up on the card — its tend job ended failed, cancelled or rejected — so its one
 * action, for an operator, tends the same step at once.
 */
function TendAgain({ c, onChanged }: { c: PullRequestCard; onChanged: () => void }) {
  const operator = useCanOperate();
  const tending = useGivingBack((s) => s[c.jobId] === 'tend');
  if (!operator || c.state !== 'open' || c.waits !== 'tend failed' || !c.tendJobId) return null;
  // Answered at once (issue #1194): the tend runs after, and the button waits until the stream says how it ended.
  const run = () => giveBack(c.jobId, 'tend', { path: '/ui/api/pull-requests/tend', body: { jobId: c.jobId }, ended: onChanged });
  return (
    <div data-slot="pr-tend-again" className="flex flex-wrap items-center gap-2 pt-1">
      <Button size="sm" disabled={tending} onClick={() => void run()}><RotateCw />{tending ? PENDING.tend : 'Tend again'}</Button>
      <span className="text-xs text-muted-foreground">A new job takes the same step. Read why it failed first.</span>
    </div>
  );
}

function Card({ c, onChanged }: { c: PullRequestCard; onChanged: () => void }) {
  const now = useNow();
  const age = c.openedAt ?? c.since;
  return (
    <li data-pull-request={c.jobId} className="space-y-1 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {c.pullRequest
          ? <GhLink url={c.pullRequest.url} className="font-medium text-foreground">#{c.pullRequest.number}<ExternalLink className="size-3 opacity-60" /></GhLink>
          : <span className="text-muted-foreground">pull request not found yet</span>}
        <GhLink url={c.issue.url} className="text-xs">{closesText(c)}</GhLink>
        <span data-slot="pr-state"><StatusBadge status={c.state} tone={STATE_TONE[c.state]} /></span>
        <span data-slot="pr-yolo"><YoloBadge on={c.yolo} /></span>
        {c.change && <span data-slot="pr-change-kind"><StatusBadge status={`change-${c.change.kind}`} label={CHANGE_KIND_TEXT[c.change.kind].label} tone={CHANGE_KIND_TEXT[c.change.kind].tone} title={changeWhy(c)} /></span>}
        {c.draft && <StatusBadge status="draft" tone="warn" />}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span data-slot="pr-checks" className={CHECKS_TONE[c.checks]}>{checksText(c)}</span>
        <span data-slot="pr-mergeable" className={c.mergeable === 'conflicts' ? 'text-bad' : ''}>{MERGEABLE_TEXT[c.mergeable]}</span>
        {age && <span title={age}>{c.openedAt ? 'opened' : 'done'} {ago(age, now)}</span>}
        {c.waits && <span data-slot="pr-waits" className={c.waits === 'ready' ? 'text-ok' : ''}>{waitsText(c)}</span>}
      </div>
      {doingText(c, now) && <div data-slot="pr-doing" className={c.gaveUp ? 'text-xs text-bad' : 'text-xs text-muted-foreground'}>{doingText(c, now)}</div>}
      {c.mergeError && <div data-slot="pr-merge-error" className="text-xs text-bad">merge refused: {c.mergeError}</div>}
      <CardActions c={c} onChanged={onChanged} />
      <TendAgain c={c} onChanged={onChanged} />
      {c.pullRequest && <PullRequestDiff repo={c.repo} number={c.pullRequest.number} />}
    </li>
  );
}

/** A repository with no checks (issue #677): the warning, and the recommended job with Queue job and Dismiss for an operator. */
function NoChecks({ r, onChanged }: { r: RepoChecks; onChanged: () => void }) {
  const operator = useCanOperate();
  const [busy, setBusy] = useState(false);
  const send = async (path: string, body: unknown, done: string) => {
    setBusy(true);
    await act(path, body, done);
    setBusy(false);
    onChanged();
  };
  const job = r.recommendation;
  return (
    <div role="note" data-slot="repo-no-checks" className="flex gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs">
      <TriangleAlert className="size-4 shrink-0 text-amber-600" />
      <div className="space-y-1">
        <p>{noChecksNote(r)}</p>
        {job && (
          <div data-slot="repo-checks-job" className="flex flex-wrap items-center gap-2">
            <span>Recommended job: <span className="font-medium">{job.title}</span></span>
            {job.queued
              ? <GhLink url={job.queued.url}>queued as #{job.queued.number}</GhLink>
              : operator && <Button size="xs" variant="outline" disabled={busy} title="File it as an issue with the hopper label, assigned to you"
                onClick={() => void send('/ui/api/repo-checks/queue', { repo: r.repo }, `Queued: ${job.title}`)}>Queue job</Button>}
            {operator && <Button size="xs" variant="ghost" disabled={busy} title="Hide this job for this repository; the warning stays"
              onClick={() => void send('/ui/api/repo-checks/dismiss', { repo: r.repo, dismissed: true }, `Dismissed for ${r.repo}`)}>Dismiss</Button>}
          </div>
        )}
      </div>
    </div>
  );
}

function RepoGroup({ group, checks, onChanged }: { group: PullRequestsView['repos'][number]; checks?: RepoChecks; onChanged: () => void }) {
  return (
    <section data-repo={group.repo}>
      <Panel title={group.repo} icon={GitPullRequest} count={group.pullRequests.length || ''} bodyClassName="p-0"
        action={<>
          {checks?.state === 'no checks' && <StatusBadge status="no-checks" label="no checks" tone="warn" />}
          <YoloBadge on={group.yolo} />
        </>}>
        <p data-slot="yolo-note" className="border-b px-4 py-2 text-xs text-muted-foreground">
          {yoloNote(group.yolo)} <a data-slot="yolo-settings" href="#settings/yolo-mode" className="underline">Change it in Settings → Yolo mode</a>
        </p>
        {checks?.state === 'no checks' && <NoChecks r={checks} onChanged={onChanged} />}
        {group.pullRequests.length
          ? <ul className="divide-y">{group.pullRequests.map((c) => <Card key={c.jobId} c={c} onChanged={onChanged} />)}</ul>
          : <Empty>no pull request waits</Empty>}
      </Panel>
    </section>
  );
}

const LANDING_TONE: Record<LandingCard['stage'], string> = {
  waiting: 'text-muted-foreground', batch_run: 'text-warn', bisecting: 'text-warn', culprit: 'text-bad', reverted: 'text-bad', promoted: 'text-ok',
};

/** Landing (issue #1073): each job pull request merged into the landing branch, and where it stands on its way to the tested branch. */
function Landing({ cards }: { cards: LandingCard[] }) {
  const now = useNow();
  return (
    <section data-slot="landing">
      <Panel title="Landing" icon={GitBranch} count={cards.length} bodyClassName="p-0">
        <p className="border-b px-4 py-2 text-xs text-muted-foreground">
          Merged into the landing branch. A batch run of the full test suite moves them to the tested branch. <a href="#settings/landing-batches" className="underline">Settings → Landing batches</a>
        </p>
        <ul className="divide-y">
          {cards.map((c) => (
            <li key={`${c.repo}#${c.pullRequest.number}`} data-landing={c.jobId ?? c.issue} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
              <GhLink url={c.pullRequest.url} className="font-medium text-foreground">{c.repo}#{c.pullRequest.number}<ExternalLink className="size-3 opacity-60" /></GhLink>
              <span data-slot="landing-stage" className={`text-xs ${LANDING_TONE[c.stage]}`}>{landingText(c)}</span>
              {c.fixIssue && <GhLink url={c.fixIssue} className="text-xs">fix issue</GhLink>}
              <span className="text-xs text-muted-foreground" title={c.since}>{ago(c.since, now)}</span>
              <PullRequestDiff repo={c.repo} number={c.pullRequest.number} />
            </li>
          ))}
        </ul>
      </Panel>
    </section>
  );
}

const UNTRACKED_TONE: Record<UntrackedPullRequest['reason'], string> = {
  no_issue: 'text-muted-foreground', issue_not_in_intake: 'text-warn', wrong_base: 'text-warn', second_pull_request: 'text-warn', not_by_a_job: 'text-muted-foreground',
};

/**
 * Take into Intake on one row (issue #1194): the daemon answers before its GitHub write. From the click on, the row says
 * the write runs and offers Take into Intake no more, until a list read after the click says how it ended: a failure, with
 * why, offers it again; the issue in Intake offers it no more. A write the daemon says runs shows the same.
 */
function TakeIn({ u, reload }: { u: UntrackedPullRequest; reload: () => void }) {
  const [sent, setSent] = useState<UntrackedPullRequest>();
  const ended = sent !== undefined && u !== sent && (u.writeBehind?.state === 'failed' || u.offer !== 'take_in');
  if (ended) setSent(undefined);
  const running = (sent && !ended) || u.writeBehind?.state === 'running';
  const failed = !running && u.writeBehind?.state === 'failed' ? u.writeBehind : undefined;
  const takeIn = async () => {
    setSent(u);
    const key = u.issue!.url;
    const r = await actFor(`/ui/api/sources/${encodeURIComponent(u.source!)}/intake`, { kind: 'take_in', keys: [key] }, `#${u.issue!.number}: taking into Intake`, intakeRefusal([key]));
    if (!r.ok) setSent(undefined);
    reload();
  };
  if (running) return <span data-write-behind="running" className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin motion-reduce:animate-none" />taking into Intake on GitHub</span>;
  if (u.offer !== 'take_in' || !u.source || !u.issue) return null;
  return (
    <>
      {failed && <span data-write-behind="failed" className="text-xs text-destructive">taking into Intake on GitHub failed: {failed.error}</span>}
      <Button size="xs" variant="outline" title="Gives the issue the hopper label and assigns it to your GitHub account: Intake lists it as a request card for you to approve" onClick={() => void takeIn()}><Inbox />Take into Intake</Button>
    </>
  );
}

/**
 * Not tracked (issue #1176): each open pull request of a job repository that no job names and the ledger does not hold, with
 * why. One whose issue is not in Intake has Take into Intake for an operator: its source labels and assigns the issue.
 */
function Untracked({ prs, reload }: { prs: UntrackedPullRequest[]; reload: () => void }) {
  const operator = useCanOperate();
  return (
    <section data-slot="untracked">
      <Panel title="Not tracked" icon={GitPullRequest} count={prs.length} bodyClassName="p-0">
        <p className="border-b px-4 py-2 text-xs text-muted-foreground">
          Open pull requests of your job repositories that the hopper does not rebase, land or close.
        </p>
        <ul className="divide-y">
          {prs.map((u) => (
            <li key={u.url} data-untracked={u.url} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
              <GhLink url={u.url} className="font-medium text-foreground">{u.repo}#{u.url.split('/').pop()}<ExternalLink className="size-3 opacity-60" /></GhLink>
              {u.title && <span className="text-muted-foreground">{u.title}</span>}
              <span data-slot="untracked-reason" className={`text-xs ${UNTRACKED_TONE[u.reason]}`}>{untrackedText(u)}</span>
              {operator && <TakeIn u={u} reload={reload} />}
            </li>
          ))}
        </ul>
      </Panel>
    </section>
  );
}

export function PullRequests() {
  const [view, setView] = useState<PullRequestsView | undefined>();
  const [checks, setChecks] = useState<RepoChecksView>({ repos: [] });
  const load = useCallback(async () => {
    const v = await get<PullRequestsView>('/api/pull-requests');
    setView(v);
    setPolled('/api/pull-requests', v);
    // The checks are read in the background on the daemon: a failed read leaves the last answer.
    const c = await get<RepoChecksView>('/api/repo-checks').catch(() => undefined);
    if (Array.isArray(c?.repos)) setChecks(c);
  }, []);
  usePoll(load, POLL_MS);
  const reload = () => { load().catch(() => {}); };
  if (!view) return <Panel title="Pull requests" icon={GitPullRequest}><Empty>loading</Empty></Panel>;
  return (
    <div className="space-y-3">
      <Panel title="Pull requests" icon={GitPullRequest}>
        <div className="space-y-1 text-sm">
          <p data-slot="pr-yolo-line">{yoloLine(view)}</p>
          <p data-slot="pr-waiting-line" className="text-muted-foreground">{waitingLine(view)}</p>
          {conflictsLine(conflictedPullRequests(view)) && <p data-slot="pr-conflicts-line" className="font-medium text-bad">{conflictsLine(conflictedPullRequests(view))}</p>}
          {noChecksLine(checks) && <p data-slot="pr-no-checks-line" className="text-warn">{noChecksLine(checks)}</p>}
          {!hasCards(view) && <p data-slot="pr-empty" className="text-muted-foreground">No pull request waits.</p>}
        </div>
      </Panel>
      {view.landing && view.landing.length > 0 && <Landing cards={view.landing} />}
      {view.untracked && view.untracked.length > 0 && <Untracked prs={view.untracked} reload={reload} />}
      {view.repos.map((g) => <RepoGroup key={g.repo} group={g} checks={checks.repos.find((c) => c.repo.toLowerCase() === g.repo.toLowerCase())} onChanged={reload} />)}
    </div>
  );
}
