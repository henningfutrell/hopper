// A source's intake outcomes grouped by why (issue #798), for Not taken and Sources: one heading per group with its count,
// then each issue — taken (with its job, and whether that job has ended since), or its reason — with the action the source
// offers: Assign to me, Release claim, Take off the backburner (GitHub writes the user makes), and a request card with
// Approve. No inner scroll box: the page scrolls, so no row hides. Each row says its issue number; an issue on the
// backburner says since when and by whom (issue #808), and has a dashed edge, so it never looks taken or dropped.
import { Flame, Hand, Unlock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { GhLink } from '@/components/job';
import { RequestCard } from '@/components/request-card';
import type { IntakeOutcome } from '../../../src/domain/intake.ts';
import { INTAKE_GROUP_LABEL, intakeGroups, issueNumber, jobEnded } from '@/model/intake';
import { ago } from '@/model/format';
import { useNow } from '@/hooks/use-now';
import { cn } from '@/lib/utils';
import { act, useHopper } from '@/store';
import { useCanOperate } from '@/store/selectors';

type Send = 'assign' | 'release' | 'unbackburner';

function Taken({ x }: { x: IntakeOutcome }) {
  // The job as the UI knows it now, else as the daemon read it: an ended job's issue is taken no more.
  const status = useHopper((s) => (x.jobId ? s.jobs[x.jobId]?.status : undefined)) ?? x.jobStatus;
  const job = x.jobId ? <span className="font-mono text-muted-foreground"> · job {x.jobId.slice(0, 8)}</span> : null;
  return jobEnded(status)
    ? <span className="text-muted-foreground">its job ended: {status}{job} · the next sync says what became of it</span>
    : <span className="text-ok">taken{job}</span>;
}

/** Why an issue is kept out: its reason, and on the backburner since when and by whom when the source read it (issue #808). */
function Reason({ x }: { x: IntakeOutcome }) {
  const now = useNow();
  const b = x.backburner;
  if (!b?.since) return <span className="text-muted-foreground">{x.reason}</span>;
  return <span data-backburner-since title={b.since} className="text-muted-foreground">on the backburner {ago(b.since, now)}{b.by ? `, by ${b.by}` : ''}</span>;
}

function Item({ x, source, canOperate }: { x: IntakeOutcome; source: string; canOperate: boolean }) {
  const send = (kind: Send, done: string) => act(`/ui/api/sources/${encodeURIComponent(source)}/intake`, { kind, keys: [x.key] }, done);
  const backburner = x.group === 'backburner';
  const n = issueNumber(x.key);
  return (
    <li data-intake-item={x.key} data-backburner={backburner || undefined}
      className={cn('flex flex-wrap items-center gap-x-2 gap-y-1', backburner && 'border-l-2 border-dashed pl-2')}>
      {n !== undefined && <span className="num text-muted-foreground">#{n}</span>}
      <GhLink url={x.key}>{x.title || x.key}</GhLink>
      {x.reason === undefined ? <Taken x={x} /> : <Reason x={x} />}
      {canOperate && x.action === 'assign' && (
        <Button size="xs" variant="outline" title="Assigns the issue to your GitHub account: the next sync takes it" onClick={() => void send('assign', 'Assigned to you')}><Hand />Assign to me</Button>
      )}
      {canOperate && x.action === 'release' && (
        <Button size="xs" variant="outline" title="Removes hopper:claimed and its holder label: no job here holds it, and the next sync takes it" onClick={() => void send('release', 'Claim released')}><Unlock />Release claim</Button>
      )}
      {canOperate && x.action === 'unbackburner' && (
        <Button size="xs" variant="outline" title="Removes hopper:backburner from the issue: the next sync takes it" onClick={() => void send('unbackburner', 'Taken off the backburner')}><Flame />Take off the backburner</Button>
      )}
      {x.action === 'approve' && x.request && <RequestCard request={x.request} source={source} itemKey={x.key} canOperate={canOperate} />}
    </li>
  );
}

/** The outcomes, grouped; `taken: false` lists only the issues not taken. */
export function IntakeGroups({ items, source, taken }: { items: IntakeOutcome[]; source: string; taken: boolean }) {
  const canOperate = useCanOperate();
  return (
    <div className="space-y-3">
      {intakeGroups(items, { taken }).map((g) => (
        <section key={g.kind} data-intake-group={g.kind} className="space-y-1">
          <h3 className="flex items-center gap-1.5 font-medium">
            {g.kind === 'backburner' && <Flame className="size-3.5 text-muted-foreground" aria-hidden />}
            {INTAKE_GROUP_LABEL[g.kind]}
            <span data-intake-group-count className={`num rounded-full px-1.5 text-[11px] font-semibold ${g.kind === 'request' ? 'bg-warn text-background' : 'bg-muted text-foreground'}`}>{g.items.length}</span>
          </h3>
          <ul className="space-y-1">{g.items.map((x) => <Item key={x.key} x={x} source={source} canOperate={canOperate} />)}</ul>
        </section>
      ))}
    </div>
  );
}
