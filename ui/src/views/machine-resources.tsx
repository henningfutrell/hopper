// Machine resources over time (issue #560): a machine's resource graph — CPU, memory, swap, disk and its lanes in
// use — on its Machines card, behind a toggle; a CPU sparkline of its last day on the card; and every machine's
// resources in one graph on the Usage page, beside plan usage. Each a usage graph card (components/usage-graph-card.tsx)
// over GET /api/machines/history, read again as the stream tells of new machine samples.
import { useCallback, useEffect, useState } from 'react';
import { Sparkline } from '@/charts/sparkline';
import { UsageGraphCard } from '@/components/usage-graph-card';
import { get } from '@/lib/api';
import { allMachineLines, machineLines, sparkValues } from '@/model/machine-history';
import type { MachineHistory, ResourceSeries } from '@/model/wire';
import { useHopper } from '@/store';

const EMPTY = 'No machine samples in this range yet. Each online machine is read every minute from now on; an offline one leaves a gap.';

/** One machine's resource graph. */
export function MachineResourcesGraph({ machineId }: { machineId: string }) {
  return (
    <UsageGraphCard<MachineHistory> path={`/api/machines/${encodeURIComponent(machineId)}/history`} linesOf={(h) => machineLines(h.series)}
      title="Resources over time" what="resource history" recordedBy="machine" empty={EMPTY} />
  );
}

/** Every machine's resources in one graph: a colour per machine, CPU solid, memory dashed, disk dotted. */
export function MachinesResourcesPanel({ className }: { className?: string }) {
  const machines = useHopper((s) => s.machines);
  const labelOf = useCallback((id: string) => { const m = machines.find((x) => x.id === id); return m?.label || id; }, [machines]);
  const linesOf = useCallback((h: MachineHistory) => allMachineLines(h.series, labelOf), [labelOf]);
  return (
    <UsageGraphCard<MachineHistory> path="/api/machines/history" linesOf={linesOf} title="Machine resources over time" what="resource history"
      recordedBy="machine" empty={EMPTY} {...(className ? { className } : {})} />
  );
}

/** Every machine's CPU over the last day, for the sparklines on the Machines cards: read again on each new sample. */
export function useCpuSparks(): readonly ResourceSeries[] {
  const recorded = useHopper((s) => s.recorded.machine);
  const [series, setSeries] = useState<readonly ResourceSeries[]>([]);
  useEffect(() => { get<MachineHistory>('/api/machines/history?range=24h').then((h) => setSeries(h.series), () => {}); }, [recorded]);
  return series;
}

export function CpuSparkline({ series, machineId }: { series: readonly ResourceSeries[]; machineId: string }) {
  const values = sparkValues(series, machineId);
  if (values.length < 2) return null;
  return (
    <div data-slot="cpu-sparkline" title="CPU busy, the last day">
      <Sparkline values={values} color="var(--busy)" height={28} />
    </div>
  );
}
