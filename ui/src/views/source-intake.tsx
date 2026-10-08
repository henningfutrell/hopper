// What a job source's intake did with each open labelled issue it listed (issue #440): taken, or the one reason
// it was not, with Assign to me and Release claim where the source offers them (a GitHub write the user makes);
// what the intake migration changed, once; and the repos outside the job repositories with issues for the user,
// each offered to add, never added by itself.
import { Hand, Plus, Unlock } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { GhLink } from '@/components/job';
import type { IntakeMigration, IntakeOutcome, OutsideRepo } from '../../../src/domain/intake.ts';
import type { SourceStatus } from '@/model/wire';
import { act } from '@/store';
import { useCanAdmin, useCanOperate } from '@/store/selectors';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const arrayOf = <T,>(v: unknown): T[] => (Array.isArray(v) ? v as T[] : []);

function Item({ x, source, canOperate }: { x: IntakeOutcome; source: string; canOperate: boolean }) {
  const send = (kind: 'assign' | 'release', done: string) => act(`/ui/api/sources/${encodeURIComponent(source)}/intake`, { kind, keys: [x.key] }, done);
  return (
    <li data-intake-item={x.key} className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <GhLink url={x.key}>{x.title || x.key}</GhLink>
      {x.reason === undefined
        ? <span className="text-ok">taken{x.jobId ? <span className="font-mono text-muted-foreground"> · job {x.jobId.slice(0, 8)}</span> : null}</span>
        : <span className="text-muted-foreground">{x.reason}</span>}
      {canOperate && x.action === 'assign' && (
        <Button size="xs" variant="outline" title="Assigns the issue to your GitHub account: the next sync takes it" onClick={() => void send('assign', 'Assigned to you')}><Hand />Assign to me</Button>
      )}
      {canOperate && x.action === 'release' && (
        <Button size="xs" variant="outline" title="Removes hopper:claimed and its holder label: no job here holds it, and the next sync takes it" onClick={() => void send('release', 'Claim released')}><Unlock />Release claim</Button>
      )}
    </li>
  );
}

function Migration({ m }: { m: IntakeMigration }) {
  return (
    <details data-intake-migration className="rounded-md border bg-muted/30 px-2 py-1">
      <summary className="cursor-pointer">Moved to the current intake rules on {new Date(m.at).toLocaleString()}: {plural(m.changes.length, 'change')}</summary>
      <ul className="mt-1 space-y-0.5">
        {m.changes.map((c) => <li key={`${c.key} ${c.change}`}><GhLink url={c.key}>{c.key}</GhLink> — {c.change}</li>)}
      </ul>
    </details>
  );
}

function Outside({ repos, addRepository }: { repos: OutsideRepo[]; addRepository?: ((repo: string) => Promise<boolean>) | undefined }) {
  const canAdmin = useCanAdmin();
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-1">
      <div className="font-medium">Issues for you outside your job repositories</div>
      <ul className="space-y-1">
        {repos.map((r) => (
          <li key={r.repo} data-outside-repo={r.repo} className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{r.repo}</span>
            <span className="text-muted-foreground">{plural(r.items.length, 'open issue')} for you</span>
            {addRepository && (
              <Button size="xs" variant="outline" disabled={!canAdmin || busy} title={canAdmin ? 'Adds it to the repositories jobs may use' : 'An admin can choose the job repositories: sign in as one'}
                onClick={() => { setBusy(true); void addRepository(r.repo).finally(() => setBusy(false)); }}><Plus />Add to job repositories</Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A source's intake: every open labelled issue it listed, its migration, and repos outside its scope. */
export function SourceIntake({ s, addRepository }: { s: SourceStatus; addRepository?: ((repo: string) => Promise<boolean>) | undefined }) {
  const canOperate = useCanOperate();
  const d = s.detail ?? {};
  const items = arrayOf<IntakeOutcome>(d.intake);
  const outside = arrayOf<OutsideRepo>(d.outsideRepos);
  const migration = d.intakeMigration as IntakeMigration | undefined;
  if (!Array.isArray(d.intake) && !migration && outside.length === 0) return null;
  const taken = items.filter((x) => x.reason === undefined);
  // Not taken first: they are what may need the user.
  const shown = [...items.filter((x) => x.reason !== undefined), ...taken];
  const assignable = items.filter((x) => x.action === 'assign').map((x) => x.key);
  return (
    <div data-intake={s.name} className="space-y-2 text-xs">
      {Array.isArray(d.intake) && <>
        <div className="flex flex-wrap items-center gap-2">
          <span data-intake-summary>{plural(items.length, 'open labelled issue')}: {taken.length} taken, {items.length - taken.length} not taken</span>
          {canOperate && assignable.length > 1 && (
            <Button size="xs" variant="outline" title="Assigns every labelled issue not assigned to you to your GitHub account"
              onClick={() => void act(`/ui/api/sources/${encodeURIComponent(s.name)}/intake`, { kind: 'assign', keys: assignable }, 'Assigned to you')}>
              <Hand />Assign all {assignable.length} to me
            </Button>
          )}
        </div>
        {shown.length > 0 && <ul className="max-h-64 space-y-1 overflow-y-auto">{shown.map((x) => <Item key={x.key} x={x} source={s.name} canOperate={canOperate} />)}</ul>}
      </>}
      {typeof d.outsideError === 'string' && <div className="text-warn">could not list issues outside the job repositories: {d.outsideError}</div>}
      {outside.length > 0 && <Outside repos={outside} addRepository={addRepository} />}
      {migration && <Migration m={migration} />}
    </div>
  );
}
