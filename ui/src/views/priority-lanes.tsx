// Priority lanes on the Machines view (issue #535): the high-priority threshold and the lanes high-priority jobs get
// first; every lane of every machine with its reliability over the window — runs, lane faults (failures that were not
// the job's fault), success, start time, the last day — its rank and why it is or is not a priority lane. An admin
// edits the settings (each saved alone, applied at the next Decision) and may choose the lanes by hand, or go back to
// reliability. A viewer reads only.
import { Star } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Panel } from '@/components/panel';
import { PriorityLaneMark } from '@/components/priority';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FIELD } from '@/components/plugin-form';
import { reliabilityText, startText } from '@/model/priority';
import type { PriorityLaneIdle, PriorityLaneSettings, PriorityLanesView, PriorityLaneView } from '@/model/wire';
import { useHopper } from '@/store';
import { refreshPriorityLanes, savePriorityLaneSettings } from '@/store/priority-lanes';
import { useCanAdmin } from '@/store/selectors';

const lanes = (n: number): string => `${n} priority lane${n === 1 ? '' : 's'}`;

/** One sentence: the threshold, how many priority lanes and how they were chosen, and what one does while none waits. */
export function summaryOf(v: PriorityLanesView): string {
  const s = v.settings;
  const chosen = v.by === 'manual' ? `${lanes(v.chosen.length)}, chosen by an admin`
    : s.count === 0 ? 'priority lanes off'
      : v.by === 'none' ? `no priority lane yet: no lane has ${s.minRuns} runs in ${s.windowDays} days`
        : `${lanes(v.chosen.length)}, chosen by reliability`;
  const idle = s.whenIdle === 'keep-free' ? 'kept free while no high-priority job waits' : 'take default jobs while no high-priority job waits, never low ones';
  return `High priority: ${s.highPriority} and above. ${chosen.charAt(0).toUpperCase()}${chosen.slice(1)}; ${idle}.`;
}

/** Priority lanes first, then by rank, then the lanes not ranked. */
const ordered = (ls: PriorityLaneView[]): PriorityLaneView[] =>
  [...ls].sort((a, b) => Number(b.priority) - Number(a.priority) || (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.laneId.localeCompare(b.laneId));

type Numbers = Pick<PriorityLaneSettings, 'highPriority' | 'count' | 'windowDays' | 'minRuns'>;
const NUMBERS: { key: keyof Numbers; id: string; label: string; min: number; max: number }[] = [
  { key: 'highPriority', id: 'priority-lanes-high', label: 'High priority from', min: 1, max: 100 },
  { key: 'count', id: 'priority-lanes-count', label: 'Priority lanes', min: 0, max: 32 },
  { key: 'windowDays', id: 'priority-lanes-window', label: 'Window, days', min: 1, max: 90 },
  { key: 'minRuns', id: 'priority-lanes-min-runs', label: 'Runs to be ranked', min: 1, max: 1000 },
];

function SettingsForm({ settings }: { settings: PriorityLaneSettings }) {
  const [draft, setDraft] = useState<Record<keyof Numbers, string>>(() => ({
    highPriority: String(settings.highPriority), count: String(settings.count), windowDays: String(settings.windowDays), minRuns: String(settings.minRuns),
  }));
  const [whenIdle, setWhenIdle] = useState<PriorityLaneIdle>(settings.whenIdle);
  const [busy, setBusy] = useState(false);
  const changed: Partial<PriorityLaneSettings> = {};
  for (const n of NUMBERS) if (Number(draft[n.key]) !== settings[n.key]) changed[n.key] = Number(draft[n.key]);
  if (whenIdle !== settings.whenIdle) changed.whenIdle = whenIdle;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (Object.keys(changed).length === 0) return;
    setBusy(true);
    await savePriorityLaneSettings(changed);
    setBusy(false);
  };
  return (
    <form data-section="priority-lane-settings" onSubmit={(e) => void save(e)} className="flex flex-wrap items-end gap-2 text-sm">
      {NUMBERS.map((n) => (
        <label key={n.key} className="grid gap-1"><span className="text-xs text-muted-foreground">{n.label}</span>
          <Input id={n.id} type="number" min={n.min} max={n.max} className="h-8 w-28" value={draft[n.key]} disabled={busy}
            onChange={(e) => setDraft({ ...draft, [n.key]: e.target.value })} /></label>
      ))}
      <label className="grid gap-1"><span className="text-xs text-muted-foreground">While no high-priority job waits</span>
        <select className={`${FIELD} h-8 w-56 text-sm`} aria-label="While no high-priority job waits" value={whenIdle} disabled={busy}
          onChange={(e) => setWhenIdle(e.target.value as PriorityLaneIdle)}>
          <option value="keep-free">a priority lane stays free</option>
          <option value="share">it takes default jobs</option>
        </select></label>
      <Button type="submit" size="sm" disabled={busy || Object.keys(changed).length === 0}>Save</Button>
    </form>
  );
}

function LaneTable({ view, admin }: { view: PriorityLanesView; admin: boolean }) {
  const rows = useMemo(() => ordered(view.lanes), [view.lanes]);
  // Keyed by the choice (below): a new choice starts the boxes from it again.
  const [picked, setPicked] = useState<Set<string>>(() => new Set(view.chosen));
  const [busy, setBusy] = useState(false);
  const differs = picked.size !== view.chosen.length || view.chosen.some((id) => !picked.has(id)) || view.by !== 'manual';
  const use = async () => {
    setBusy(true);
    await savePriorityLaneSettings({ manual: rows.map((r) => r.laneId).filter((id) => picked.has(id)) }, 'Priority lanes chosen');
    setBusy(false);
  };
  const auto = async () => {
    setBusy(true);
    await savePriorityLaneSettings({ manual: null }, 'Priority lanes chosen by reliability');
    setBusy(false);
  };
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-xs">
          <thead className="text-left text-muted-foreground">
            <tr>{admin && <th className="w-8 py-1 font-normal"><span className="sr-only">choose</span></th>}
              <th className="py-1 font-normal">Lane</th><th className="py-1 font-normal">Rank</th><th className="py-1 font-normal">Reliability ({view.settings.windowDays} days)</th>
              <th className="py-1 font-normal">Median start</th><th className="py-1 font-normal">Last day</th><th className="py-1 font-normal">Why</th></tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((l) => (
              <tr key={l.laneId} data-priority-lane={l.laneId} className={l.priority ? 'bg-muted/30' : ''}>
                {admin && <td className="py-1.5"><input type="checkbox" data-choose={l.laneId} aria-label={`priority lane ${l.laneId}`} checked={picked.has(l.laneId)} disabled={busy}
                  onChange={() => { const next = new Set(picked); if (next.has(l.laneId)) next.delete(l.laneId); else next.add(l.laneId); setPicked(next); }} /></td>}
                <td className="py-1.5 font-mono whitespace-nowrap">{l.laneId} {l.priority && <PriorityLaneMark className="ml-1" />}</td>
                <td className="num py-1.5">{l.rank ?? '—'}</td>
                <td className="py-1.5">{reliabilityText(l)}{l.successRate !== undefined && <span className="text-muted-foreground"> · {Math.round(l.successRate * 100)}% finished</span>}</td>
                <td className="num py-1.5">{startText(l.medianStartMs)}</td>
                <td className="num py-1.5">{l.recentFaults ? `${l.recentFaults} lane fault${l.recentFaults === 1 ? '' : 's'}` : '—'}</td>
                <td className="py-1.5 text-muted-foreground">{l.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {admin && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy || !differs} onClick={() => void use()}>Use these lanes</Button>
          {view.settings.manual && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void auto()}>Choose by reliability</Button>}
        </div>
      )}
    </div>
  );
}

export function PriorityLanesPanel() {
  const view = useHopper((s) => s.priorityLanes);
  const admin = useCanAdmin();
  useEffect(() => { refreshPriorityLanes().catch(() => {}); }, []);
  // Until read, or an answer without its lanes (a daemon before this): nothing to show.
  if (!view || !Array.isArray(view.lanes) || !view.settings) return null;
  return (
    <Panel title="Priority lanes" icon={Star} count={view.chosen.length} bodyClassName="space-y-3">
      <p data-slot="priority-lanes-summary" className="text-sm text-muted-foreground">{summaryOf(view)}</p>
      <p className="text-xs text-muted-foreground">
        The most reliable lanes are the priority lanes: the share of their runs without a lane fault — the machine offline or not dialled in, a start or a
        dialog the agent could not get past, a pane lost — newer runs counting more. One stays a priority lane until another is better by more than {Math.round(view.switchMargin * 100)} points.
      </p>
      {admin && <SettingsForm key={JSON.stringify(view.settings)} settings={view.settings} />}
      <LaneTable key={`${view.by}:${view.chosen.join(',')}`} view={view} admin={admin} />
    </Panel>
  );
}
