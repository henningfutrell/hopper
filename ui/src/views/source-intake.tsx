// A job source's intake in Sources (issue #440): how many open labelled issues it listed, taken and not, and a link to
// Intake, their one home (issue #897), where each is listed with its actions — Approve among them —; what the intake
// migration changed, once; and the repos outside the job repositories with issues for the user, each offered to add,
// never added by itself.
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { GhLink } from '@/components/job';
import type { IntakeMigration, IntakeOutcome, OutsideRepo } from '../../../src/domain/intake.ts';
import type { SourceStatus } from '@/model/wire';
import { useCanAdmin } from '@/store/selectors';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const arrayOf = <T,>(v: unknown): T[] => (Array.isArray(v) ? v as T[] : []);

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

/** A source's intake: its count and a link to Intake, its migration, and repos outside its scope. */
export function SourceIntake({ s, addRepository }: { s: SourceStatus; addRepository?: ((repo: string) => Promise<boolean>) | undefined }) {
  const d = s.detail ?? {};
  const items = arrayOf<IntakeOutcome>(d.intake);
  const outside = arrayOf<OutsideRepo>(d.outsideRepos);
  const migration = d.intakeMigration as IntakeMigration | undefined;
  if (!Array.isArray(d.intake) && !migration && outside.length === 0) return null;
  const taken = items.filter((x) => x.reason === undefined).length;
  const requests = items.filter((x) => x.action === 'approve').length;
  return (
    <div className="space-y-2 text-xs">
      {Array.isArray(d.intake) && (
        <a href="#intake" data-intake-link={s.name} className="block hover:underline">
          <span data-intake-summary>{plural(items.length, 'open labelled issue')}: {taken} taken, {items.length - taken} not taken</span>
          {requests > 0 && <span className="text-warn"> · {plural(requests, 'request waits', 'requests wait')} for approval</span>} · see Intake →
        </a>
      )}
      {typeof d.outsideError === 'string' && <div className="text-warn">could not list issues outside the job repositories: {d.outsideError}</div>}
      {outside.length > 0 && <Outside repos={outside} addRepository={addRepository} />}
      {migration && <Migration m={migration} />}
    </div>
  );
}
