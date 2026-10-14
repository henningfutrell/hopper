// The Jobs view's filters (issues #434, #1113): a select by stage or repository, the counts per stage — each also its
// stage's filter —, and the in-flight toggle, which the hash holds (#jobs/in-flight) so the header badge's link turns it on.
import { Activity } from 'lucide-react';
import { FIELD } from '@/components/plugin-form';
import { COLOR } from '@/components/status';
import { cn } from '@/lib/utils';
import { IN_FLIGHT_SECTION, STAGES } from '@/model/jobs-view';
import type { JobStage } from '@/model/wire';

export function Filter<T extends string>({ slot, label, value, choices, name, onPick }: { slot: string; label: string; value: T | null; choices: readonly T[]; name: (v: T) => string; onPick: (v: T | null) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">{label}
      <select data-slot={slot} className={cn(FIELD, 'w-36')} value={value ?? ''} onChange={(e) => onPick(e.target.value === '' ? null : (e.target.value as T))}>
        <option value="">all</option>
        {/* A choice no job has any more stays selectable, so the filter never changes by itself. */}
        {[...new Set([...(value ? [value] : []), ...choices])].map((c) => <option key={c} value={c}>{name(c)}</option>)}
      </select>
    </label>
  );
}

/** How many jobs are in each stage; a count is a button that filters to its stage. */
export function StageCounts({ counts, chosen, onPick }: { counts: Partial<Record<JobStage, number>>; chosen: JobStage | null; onPick: (s: JobStage | null) => void }) {
  return (
    <div data-slot="jobs-stage-counts" className="flex flex-wrap gap-1.5 border-b px-4 py-2">
      {STAGES.filter((s) => s.stage !== 'no_job').map((s) => {
        const n = counts[s.stage] ?? 0;
        const on = chosen === s.stage;
        return (
          <button key={s.stage} type="button" data-slot="jobs-stage-count" data-stage={s.stage} title={s.title} aria-pressed={on}
            onClick={() => onPick(on ? null : s.stage)} disabled={n === 0 && !on}
            className={cn('inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs disabled:opacity-40', on ? 'border-foreground/40 bg-muted' : 'hover:bg-muted/60')}>
            <span className="size-2 rounded-full" style={{ background: COLOR[s.tone] }} />
            <span>{s.label}</span>
            <span className="num font-mono font-medium">{n}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Only the jobs in flight, or every job: the hash says which, so the back button and the header badge's link agree. */
export function InFlightToggle({ on }: { on: boolean }) {
  return (
    <button type="button" data-slot="jobs-filter-in-flight" aria-pressed={on} title="Only the jobs in flight: working, or a pull request with its checks running, its checks being fixed, or waiting on the merge"
      onClick={() => { window.location.hash = on ? '#jobs' : `#jobs/${IN_FLIGHT_SECTION}`; }}
      className={cn('inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs', on ? 'border-foreground/40 bg-muted' : 'hover:bg-muted/60')}><Activity className="size-3.5" />In flight</button>
  );
}
