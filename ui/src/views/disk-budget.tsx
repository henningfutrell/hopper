// The disk budget on Machines (issue #1120, design.md "Hopper's own disk use" → "Part 2"): the most the hopper's own disk
// use (its scratch areas, job worktrees and repository checkouts) may be on each machine. GET /api/machines/disk-budget reads it; an admin sets
// it or turns it off (POST /ui/api/machines/disk-budget). Each machine's card shows its use against it.
import { useEffect, useState } from 'react';
import { HardDrive } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Empty, Panel } from '@/components/panel';
import { get } from '@/lib/api';
import { budgetBody, budgetDraft } from '@/model/hopper-disk';
import { allows } from '@/model/roles';
import type { DiskBudget } from '@/model/wire';
import { act, refreshLive, useHopper } from '@/store';

export function DiskBudgetPanel() {
  const canSet = useHopper((s) => allows(s.user, 'admin'));
  const [budget, setBudget] = useState<DiskBudget | null | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const show = (b: DiskBudget | null) => { setBudget(b); setDraft(budgetDraft(b)); };
  useEffect(() => {
    get<{ diskBudget: DiskBudget | null }>('/api/machines/disk-budget').then((r) => show(r.diskBudget), () => {});
  }, []);
  const body = budgetBody(draft);
  const save = async (next: { budget: DiskBudget | null }) => {
    const done = next.budget ? `Disk budget ${next.budget.bytes / 1e9} GB per machine` : 'No disk budget';
    if (await act('/ui/api/machines/disk-budget', next, done)) { show(next.budget); await refreshLive().catch(() => {}); }
  };
  return (
    <Panel title="Disk budget" icon={HardDrive} bodyClassName="space-y-2">
      <p className="text-xs text-muted-foreground">
        The most disk the hopper's own files (job scratch dirs, job worktrees and the repository checkouts they are made of) may use on each machine. Over it, the sweep removes
        every ended job's files at once, but never work not pushed. If it is still over, you are told (webhooks and notifiers).
      </p>
      {budget === undefined ? <Empty>loading</Empty> : (
        <form className="flex flex-wrap items-center gap-2 text-sm" onSubmit={(e) => { e.preventDefault(); if (typeof body !== 'string') void save(body); }}>
          <label htmlFor="disk-budget-gb">At most</label>
          <Input id="disk-budget-gb" type="number" min={0.1} step={0.1} inputMode="decimal" className="h-8 w-24" value={draft} disabled={!canSet}
            placeholder="none" onChange={(e) => setDraft(e.target.value)} />
          <span>GB per machine</span>
          {canSet && <Button type="submit" size="sm" variant="secondary" disabled={typeof body === 'string'}>Save</Button>}
          {!budget && <span className="text-xs text-muted-foreground">no budget</span>}
          {canSet && typeof body === 'string' && <span role="alert" className="text-xs text-destructive">{body}</span>}
        </form>
      )}
    </Panel>
  );
}
