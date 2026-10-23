// The disk defaults on Machines (issue #2494, design.md "Hopper's own disk use" → "Part 13"): the disk thresholds and the
// sweep settings every machine takes where its own options are silent. GET /api/machines/disk-defaults reads them; an admin
// sets them or clears them (POST /ui/api/machines/disk-defaults).
import { useEffect, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Empty, Panel } from '@/components/panel';
import { get } from '@/lib/api';
import { DISK_DEFAULT_FIELDS, diskDefaultsBody, diskDefaultsDraft, type DiskDefaultsDraft } from '@/model/disk-defaults';
import { allows } from '@/model/roles';
import type { DiskDefaults } from '@/model/wire';
import { act, refreshLive, useHopper } from '@/store';

const GROUPS = [...new Set(DISK_DEFAULT_FIELDS.map((f) => f.group))];

export function DiskDefaultsPanel() {
  const canSet = useHopper((s) => allows(s.user, 'admin'));
  const [defaults, setDefaults] = useState<DiskDefaults | null | undefined>(undefined);
  const [draft, setDraft] = useState<DiskDefaultsDraft>({});
  const show = (d: DiskDefaults | null) => { setDefaults(d); setDraft(diskDefaultsDraft(d)); };
  useEffect(() => {
    get<{ diskDefaults: DiskDefaults | null }>('/api/machines/disk-defaults').then((r) => show(r.diskDefaults), () => {});
  }, []);
  const body = diskDefaultsBody(draft);
  const save = async (next: { defaults: DiskDefaults | null }) => {
    if (await act('/ui/api/machines/disk-defaults', next, next.defaults ? 'Disk defaults saved' : 'No disk defaults')) { show(next.defaults); await refreshLive().catch(() => {}); }
  };
  return (
    <Panel title="Disk defaults" icon={SlidersHorizontal} bodyClassName="space-y-2">
      <p className="text-xs text-muted-foreground">
        What every machine takes when its own machine options do not set it: when its disk is low or critical, how often the sweep runs, how long an
        ended job's work stays, the storage prune, the trim, the cache caps and the dry run. A machine's own option always wins. Empty: no default.
      </p>
      {defaults === undefined ? <Empty>loading</Empty> : (
        <form className="space-y-3 text-sm" onSubmit={(e) => { e.preventDefault(); if (typeof body !== 'string') void save(body); }}>
          {GROUPS.map((group) => (
            <fieldset key={group} className="space-y-1">
              <legend className="text-xs font-medium text-muted-foreground">{group}</legend>
              <div className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
                {DISK_DEFAULT_FIELDS.filter((f) => f.group === group).map((f) => (
                  <label key={f.name} htmlFor={`disk-default-${f.name}`} className="flex items-center justify-between gap-2">
                    <span>{f.label}</span>
                    {f.flag
                      ? <input id={`disk-default-${f.name}`} type="checkbox" className="h-4 w-4" checked={draft[f.name] === 'on'} disabled={!canSet}
                          onChange={(e) => setDraft({ ...draft, [f.name]: e.target.checked ? 'on' : '' })} />
                      : <Input id={`disk-default-${f.name}`} type="number" min={0} step="any" inputMode="decimal" className="h-8 w-24" value={draft[f.name] ?? ''}
                          disabled={!canSet} placeholder="none" onChange={(e) => setDraft({ ...draft, [f.name]: e.target.value })} />}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            {canSet && <Button type="submit" size="sm" variant="secondary" disabled={typeof body === 'string'}>Save</Button>}
            {!defaults && <span className="text-xs text-muted-foreground">no defaults</span>}
            {canSet && typeof body === 'string' && <span role="alert" className="text-xs text-destructive">{body}</span>}
          </div>
        </form>
      )}
    </Panel>
  );
}
