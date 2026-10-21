// A source's intake outcomes grouped by why (issue #798), for Intake (issue #897): one heading per group with its count,
// then each issue waiting on an intake decision (issue #1035) — its reason — with the action the source
// offers: Assign to me, Release claim, Take off the backburner (GitHub writes the user makes), and a request card with
// Approve and Decline (issue #1035). No inner scroll box: the page scrolls, so no row hides. Each row says its issue as
// owner/repo#number, one link to the issue on GitHub with its title (issue #1463); Not assigned to you says why its issues
// are not taken; with `repo`, only that repository's issues show, and the counts are of those. An issue on the
// backburner says since when and by whom (issue #808), and has a dashed edge, so it never looks taken or dropped. An issue a
// person approved here stays in its place in Needs approval, says approved and what the sync made of it, and takes the
// focus (issue #811): the list does not move under the person who acted. So does an issue declined here (issue #1035). Taken and partly done issues are on Jobs.
// The source's list is the source of truth (issue #1178): a decision it makes stale is forgotten — the card asks again, and
// an item whose job ended leaves Needs approval —, and an approved row says what it waits on: no job yet, or its job and state.
// Assign to me, Release claim and Take off the backburner answer before their GitHub write (issue #1194): from the click on,
// the row says the write runs and offers that action no more; a write that failed says why, and offers it again.
// A blocked item (issue #1891: no pull request to wait on, or its pull request closed without a merge) offers Won't do,
// which drops it, its label change a write-behind too, and Run again on its job.
// Each row says when it arrived in Intake (issue #2228): its age, and the time in the viewer's time zone on hover.
import { Ban, ExternalLink, Flame, Hand, Loader2, RotateCcw, Unlock } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { GhLink } from '@/components/job';
import { RequestCard } from '@/components/request-card';
import type { IntakeActionKind, IntakeOutcome } from '../../../src/domain/intake.ts';
import { DECLINED_ROW, INTAKE_GROUP_LABEL, intakeGroups, intakeRef, jobEnded, repoOf } from '@/model/intake';
import type { IntakeGroupKind } from '@/model/intake';
import { ago, zonedTime } from '@/model/format';
import { useNow } from '@/hooks/use-now';
import { cn } from '@/lib/utils';
import { actFor, useHopper } from '@/store';
import { giveBack, useGivingBack } from '@/store/give-back';
import { forgetEndedApprovals, intakeRefusal, keepsPlace, reconcileApprovals, useApprovals } from '@/store/intake';
import { useCanOperate } from '@/store/selectors';

type Send = 'assign' | 'release' | 'unbackburner' | 'wont_do';

/** What a write-behind does on GitHub, as the row says it. */
const WRITE_BEHIND: Partial<Record<IntakeActionKind, string>> = {
  assign: 'assigning to you on GitHub', release: 'releasing the claim on GitHub', unbackburner: 'taking out of Later on GitHub',
  approve: 'updating the issue on GitHub', wont_do: 'marking it hopper:rejected on GitHub',
};

/**
 * The GitHub write an action left after its answer (issue #1194): sent from this page, running, or failed. What was sent
 * shows until a list the daemon sent after it says how it ended: a failure, or the action no longer offered.
 */
function useWriteBehind(x: IntakeOutcome) {
  const [sent, setSent] = useState<{ kind: Send; on: IntakeOutcome }>();
  const ended = sent !== undefined && x !== sent.on && (x.writeBehind?.state === 'failed' || x.action !== sent.kind);
  if (ended) setSent(undefined);
  const mine = ended ? undefined : sent;
  const running = mine?.kind ?? (x.writeBehind?.state === 'running' ? x.writeBehind.act : undefined);
  const failed = !mine && x.writeBehind?.state === 'failed' ? x.writeBehind : undefined;
  // A write the GitHub outbox tries again by itself (issue #1238): why the try before failed.
  const retry = !mine && x.writeBehind?.state === 'running' ? x.writeBehind.error : undefined;
  return { running, failed, retry, send: (kind: Send) => setSent({ kind, on: x }), unsend: () => setSent(undefined) };
}

function WriteBehindLine({ running, retry, failed }: { running?: IntakeActionKind; retry?: string; failed?: { act: IntakeActionKind; error: string } }) {
  if (running) return <span data-write-behind="running" className="inline-flex items-center gap-1 text-muted-foreground"><Loader2 className="size-3 animate-spin motion-reduce:animate-none" />{WRITE_BEHIND[running] ?? 'updating GitHub'}{retry ? `, trying again: ${retry}` : ''} ·</span>;
  if (failed) return <span data-write-behind="failed" className="text-destructive">{WRITE_BEHIND[failed.act] ?? 'updating GitHub'} failed: {failed.error} ·</span>;
  return null;
}

function Taken({ x }: { x: IntakeOutcome }) {
  // The job as the UI knows it now, else as the daemon read it: an ended job's issue is taken no more.
  const status = useHopper((s) => (x.jobId ? s.jobs[x.jobId]?.status : undefined)) ?? x.jobStatus;
  const job = x.jobId ? <span className="font-mono text-muted-foreground"> · job {x.jobId.slice(0, 8)}</span> : null;
  return jobEnded(status)
    ? <span className="text-muted-foreground">its job ended: {status}{job} · the next sync says what became of it</span>
    : <span data-taken className="text-ok">taken{job}{status ? <span className="text-muted-foreground"> · {status}</span> : null}</span>;
}

/** Why an issue is kept out: its reason, and on the backburner since when and by whom when the source read it (issue #808). */
function Reason({ x }: { x: IntakeOutcome }) {
  const now = useNow();
  const b = x.backburner;
  if (!b?.since) return <span className="text-muted-foreground">{x.reason}</span>;
  return <span data-backburner-since title={b.since} className="text-muted-foreground">on the backburner {ago(b.since, now)}{b.by ? `, by ${b.by}` : ''}</span>;
}

/** When the hopper first listed the issue (issue #2228): its age, and the time in the viewer's time zone on hover. */
function Arrived({ at }: { at: string }) {
  const now = useNow();
  return <time data-intake-arrived dateTime={at} title={`Arrived in Intake ${zonedTime(at)}`} className="text-muted-foreground">arrived {ago(at, now)}</time>;
}

/** Moves the focus to the row once its approval or decline goes through: its buttons are gone, and the focus must not be lost. */
function useFocusOnApproved(key: string) {
  const row = useRef<HTMLLIElement>(null);
  const state = useApprovals((s) => s[key]?.state);
  const was = useRef(state);
  useEffect(() => {
    if ((was.current === 'pending' && state === 'approved') || (was.current === 'declining' && state === 'declined')) row.current?.focus({ preventScroll: true });
    was.current = state;
  }, [state]);
  return { row, state };
}

function Item({ x, source, canOperate }: { x: IntakeOutcome; source: string; canOperate: boolean }) {
  const writeBehind = useWriteBehind(x);
  const { running, retry, failed } = writeBehind;
  const send = async (kind: Send, done: string) => {
    writeBehind.send(kind);
    const r = await actFor(`/ui/api/sources/${encodeURIComponent(source)}/intake`, { kind, keys: [x.key] }, done, intakeRefusal([x.key]));
    if (!r.ok) writeBehind.unsend();
  };
  const offers = (kind: Send) => canOperate && x.action === kind && running !== kind;
  const backburner = x.group === 'backburner';
  const ref = intakeRef(x);
  const { row, state } = useFocusOnApproved(x.key);
  const declinedAs = useApprovals((s) => { const a = s[x.key]; return a?.state === 'declined' ? a.choice : undefined; });
  const rerunning = useGivingBack((s) => (x.jobId ? s[x.jobId] : undefined)) !== undefined;
  const asked = x.action !== 'approve'; // the sync took the approved or declined issue: its request card is gone, the decision shows here
  return (
    <li ref={row} tabIndex={state === 'approved' || state === 'declined' ? -1 : undefined} data-intake-item={x.key} data-backburner={backburner || undefined}
      className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 outline-none', backburner && 'border-l-2 border-dashed pl-2')}>
      <GhLink url={x.key}>
        {ref !== undefined && <span data-intake-ref className="num font-mono">{ref}</span>}
        <span>{x.title || x.key}</span>
        <ExternalLink className="size-3 opacity-60" aria-hidden />
      </GhLink>
      {asked && state === 'pending' && <span data-approving className="inline-flex items-center gap-1 text-muted-foreground"><Loader2 className="size-3 animate-spin motion-reduce:animate-none" />approving ·</span>}
      {asked && state === 'approved' && <span data-approved className="text-ok">approved ·</span>}
      {asked && state === 'approved' && x.reason !== undefined && <span data-approved-waits className="text-muted-foreground">no job yet ·</span>}
      {asked && state === 'declining' && <span data-declining className="inline-flex items-center gap-1 text-muted-foreground"><Loader2 className="size-3 animate-spin motion-reduce:animate-none" />declining ·</span>}
      {asked && state === 'declined' && <span data-declined className="text-muted-foreground">{DECLINED_ROW[declinedAs ?? 'open']} ·</span>}
      <WriteBehindLine running={running} retry={retry} failed={failed} />
      {x.reason === undefined ? <Taken x={x} /> : <Reason x={x} />}
      {x.arrivedAt !== undefined && <Arrived at={x.arrivedAt} />}
      {offers('assign') && (
        <Button size="xs" variant="outline" title="Assigns the issue to your GitHub account: the next sync takes it" onClick={() => void send('assign', 'Assigning to you')}><Hand />Assign to me</Button>
      )}
      {offers('release') && (
        <Button size="xs" variant="outline" title="Removes hopper:claimed and its holder label: no job here holds it, and the next sync takes it" onClick={() => void send('release', 'Releasing the claim')}><Unlock />Release claim</Button>
      )}
      {offers('unbackburner') && (
        <Button size="xs" variant="outline" title="Removes hopper:backburner from the issue: the next sync takes it" onClick={() => void send('unbackburner', 'Taking out of Later')}><Flame />Take out of Later</Button>
      )}
      {offers('wont_do') && (
        <Button size="xs" variant="outline" title="Drops the item: the hopper takes its blocked label off and puts hopper:rejected on, so no hopper takes it again" onClick={() => void send('wont_do', 'Won\'t do: dropping it')}><Ban />Won't do</Button>
      )}
      {canOperate && x.action === 'wont_do' && x.jobId && running !== 'wont_do' && (
        <Button size="xs" variant="outline" disabled={rerunning} title="Runs its job again: the hopper gives the issue back on GitHub first" onClick={() => void giveBack(x.jobId!, 'rerun')}><RotateCcw />Run again</Button>
      )}
      {x.action === 'approve' && x.request && <RequestCard request={x.request} source={source} itemKey={x.key} canOperate={canOperate} />}
    </li>
  );
}

/** Why a group's issues are not taken, where the reason on each row does not say it all (issue #1463). */
/** A group label's tooltip, where the label alone is a plain word for a hopper term (issue #2375). */
const GROUP_TITLE: Partial<Record<IntakeGroupKind, string>> = {
  backburner: 'On the backburner: the hopper:backburner label is on these issues, so no job starts on them until you take them out of Later.',
};

const GROUP_WHY: Partial<Record<IntakeGroupKind, string>> = {
  'not-assigned': 'Intake takes a labelled issue only when it is assigned to you, or when you comment /hopper run on it. Nothing works on these issues until you do.',
};

/** The outcomes waiting on an intake decision, grouped; with `repo`, only that repository's (issue #1463). */
export function IntakeGroups({ items, source, repo }: { items: IntakeOutcome[]; source: string; repo?: string }) {
  const canOperate = useCanOperate();
  const approvals = useApprovals();
  const jobs = useHopper((s) => s.jobs);
  const kept = useMemo(() => new Set(Object.keys(approvals).filter((k) => keepsPlace(approvals[k]))), [approvals]);
  useEffect(() => reconcileApprovals(items, (id) => jobs[id]?.status), [items, jobs]);
  useEffect(() => forgetEndedApprovals, []);
  return (
    <div className="space-y-3">
      {intakeGroups(repo === undefined ? items : items.filter((x) => repoOf(x) === repo), kept).map((g) => (
        <section key={g.kind} data-intake-group={g.kind} className="space-y-1">
          <h3 data-slot="intake-group-label" title={GROUP_TITLE[g.kind]} className="flex items-center gap-1.5 font-medium">
            {g.kind === 'backburner' && <Flame className="size-3.5 text-muted-foreground" aria-hidden />}
            {INTAKE_GROUP_LABEL[g.kind]}
            <span data-intake-group-count className={`num rounded-full px-1.5 text-[11px] font-semibold ${g.kind === 'request' ? 'bg-warn text-background' : 'bg-muted text-foreground'}`}>{g.count}</span>
          </h3>
          {GROUP_WHY[g.kind] && <p data-intake-group-why className="text-muted-foreground">{GROUP_WHY[g.kind]}</p>}
          <ul className="space-y-1">{g.items.map((x) => <Item key={x.key} x={x} source={source} canOperate={canOperate} />)}</ul>
        </section>
      ))}
    </div>
  );
}
