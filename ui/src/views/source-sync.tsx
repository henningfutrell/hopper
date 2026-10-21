// A job source's sync (issue #254): what it saw and made, when it last synced, and what is wrong with
// it — on a source's card in Sources, and inside the GitHub connection's panel for that connection's source.
import { GhLink } from '@/components/job';
import { ago, countdown, duration } from '@/model/format';
import type { SourceStatus } from '@/model/wire';
import { Button } from '@/components/ui/button';
import { actFor } from '@/store';
import { intakeRefusal } from '@/store/intake';
import { useCanOperate, useServerNow } from '@/store/selectors';
import { SourceIntake } from './source-intake';

const list = (v: unknown) => (Array.isArray(v) ? v.join(', ') : String(v));
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const empty = (v: unknown) => v == null || v === 0 || (typeof v === 'object' && Object.keys(v as object).length === 0);

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return <div><div className="text-[11px] text-muted-foreground">{label}</div><div data-stat className="num text-lg font-semibold">{value}</div></div>;
}

/** A failed row of the GitHub outbox (issue #1238), one per item and act: a person's Retry sends it again. */
interface OutboxFailed { key: string; repo: string; act: string; error: string; attempts: number }

/** What a failed row's act did, in plain words. */
const ACT: Record<string, string> = {
  assign: 'Assign to me', release: 'Release claim', approve: 'Approve', unbackburner: 'Take out of Later',
  take_in: 'Take into Intake', resolve: 'Hand-off resolution', merge: 'Merge now', close: 'Close PR',
  rerun: 'Run again', rework: 'Rework', retry: 'Retry', continue: 'Continue', fixed: 'I fixed it', push: 'Push it', tend: 'Tend again',
};

/**
 * The GitHub writes a person's acts left after their answer, in the GitHub outbox (issues #1194, #1238): how many are under
 * way, when the last went through, and each that failed, with a Retry. None when no write ever ran.
 */
function WriteBehind({ s, now }: { s: SourceStatus; now: number }) {
  const canOperate = useCanOperate();
  const d = s.detail ?? {};
  const pending = typeof d.writeBehindPending === 'number' ? d.writeBehindPending : 0;
  const last = str(d.lastWriteBehindAt);
  const failed = Array.isArray(d.outboxFailed) ? (d.outboxFailed as OutboxFailed[]) : [];
  const errors = d.writeBehindErrors && typeof d.writeBehindErrors === 'object' ? Object.entries(d.writeBehindErrors as Record<string, string>) : [];
  if (!pending && !last && !errors.length && !failed.length) return null;
  const retry = (key: string) => actFor(`/ui/api/sources/${encodeURIComponent(s.name)}/intake`, { kind: 'retry_outbox', keys: [key] }, 'Sending it again', intakeRefusal([key]));
  return (
    <div data-write-behind={s.name} className="space-y-0.5 text-xs text-muted-foreground">
      <div>GitHub writes: {pending ? <span className="text-foreground/80">{pending} under way</span> : 'none under way'}
        {last && <> · last went through <span title={last}>{ago(last, now)}</span></>}</div>
      {failed.length > 0
        ? failed.map((f) => (
          <div key={`${f.key} ${f.act}`} data-outbox-failed={f.key} className="flex flex-wrap items-center gap-x-2 text-bad">
            <span><GhLink url={f.key}>{f.key}</GhLink>: {ACT[f.act] ?? f.act} failed: {f.error}</span>
            {canOperate && <Button data-outbox-retry size="xs" variant="outline" title="Sends this GitHub write again" onClick={() => void retry(f.key)}>Retry</Button>}
          </div>
        ))
        : errors.map(([key, why]) => <div key={key} data-write-behind-error className="text-bad"><GhLink url={key}>{key}</GhLink>: {why}</div>)}
    </div>
  );
}

/**
 * How often a source polls (issue #1264): its poll interval, and the longer interval to its next poll while its syncs find
 * nothing changed; and its calls to GitHub in the last hour and day, from the hopper's database.
 */
function PollAndCalls({ s }: { s: SourceStatus }) {
  const backedOff = s.pollMs !== undefined && s.nextPollMs !== undefined && s.nextPollMs > s.pollMs;
  return (
    <>
      {s.pollMs !== undefined && <div data-poll={s.name}>polls every {duration(s.pollMs / 1000)}
        {backedOff && <> · <span className="text-foreground/80">nothing changed: next poll after {duration(s.nextPollMs! / 1000)}</span></>}</div>}
      {s.calls && <div data-calls={s.name}>{s.kind.startsWith('github') ? 'GitHub calls' : 'calls'}: <span className="num text-foreground/80">{s.calls.lastHour}</span> in the last hour · <span className="num text-foreground/80">{s.calls.lastDay}</span> in the last day</div>}
    </>
  );
}

/** A source's sync: what it saw and made, when, and what is wrong with it; and what its intake did with each item (issue #440). */
export function SourceSync({ s, addRepository }: { s: SourceStatus; addRepository?: ((repo: string) => Promise<boolean>) | undefined }) {
  const now = useServerNow(); // the daemon's clock: its times are its own (issue #812)
  const d = s.detail ?? {};
  return (
    <div data-source-sync={s.name} className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <Stat label="seen" value={s.itemsSeen} /><Stat label="created" value={s.jobsCreated} /><Stat label="active" value={s.activeJobs} />
      </div>
      <div className="num text-xs text-muted-foreground">
        <span className="font-mono">{s.kind}</span> · last sync <span title={s.lastSyncAt}>{ago(s.lastSyncAt, now)}</span>
        {s.syncing ? <> · <span data-syncing>syncing now</span></>
          : s.nextSyncAt && <> · next <span title={s.nextSyncAt}>{Date.parse(s.nextSyncAt) > now ? countdown(s.nextSyncAt, now) : 'now'}</span></>}
      </div>
      {s.duplicateOf && <div data-duplicate-of={s.name} className="rounded-md border border-bad/30 bg-bad/5 p-2 text-xs text-bad">Duplicate of <span className="font-mono">{s.duplicateOf}</span>: it polls GitHub again for the same issues. Remove it from the banner above.</div>}
      <WriteBehind s={s} now={now} />
      {s.lastError && <div className="rounded-md border border-bad/30 bg-bad/5 p-2 text-xs break-words text-bad">{s.lastError}</div>}
      <div className="space-y-0.5 text-xs text-muted-foreground">
        <PollAndCalls s={s} />
        {['owners', 'repos', 'assignee', 'label'].filter((k) => d[k] != null && list(d[k]) !== '').map((k) => <div key={k}>{k}: <span className="text-foreground/80">{list(d[k])}</span></div>)}
        {['projectErrors', 'permanentErrors'].filter((k) => !empty(d[k])).map((k) => <div key={k} className="text-bad">{k}: {typeof d[k] === 'object' ? JSON.stringify(d[k]) : String(d[k])}</div>)}
        {Array.isArray(d.notRerun) && d.notRerun.map((n: { key: string; job: string; status: string; reason: string }) => <div key={n.key} data-not-rerun className="text-warn">not run again: <GhLink url={n.key}>{n.key}</GhLink> (job {n.status}, {n.reason})</div>)}
        {d.enabledSetting != null && <div>enabled setting: <code>{String(d.enabledSetting)}</code></div>}
      </div>
      <SourceIntake s={s} addRepository={addRepository} />
    </div>
  );
}
