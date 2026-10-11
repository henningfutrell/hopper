// Job costs (issue #688), on Machines: what a finished job costs its machine, grouped by job cost kind, repository or
// template — the jobs, the mean duration, one lane's share of CPU, memory and disk net of the machine's baseline, and
// the usage burned per usage window. Read from GET /api/lanes/costs (`hopper lanes costs` reads the same), again as new
// machine samples come in.
import { Receipt } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { get } from '@/lib/api';
import { bytesText, cpuText, durationText, groupJobsText, usageText } from '@/model/job-costs';
import type { JobCostGrouping, JobCosts } from '@/model/wire';
import { useHopper } from '@/store';

const GROUPINGS: readonly { by: JobCostGrouping; label: string; empty: string }[] = [
  { by: 'kind', label: 'Kind', empty: '' },
  { by: 'repo', label: 'Repository', empty: 'No finished job had a repository.' },
  { by: 'template', label: 'Template', empty: 'No job ran on a sandbox box of a template.' },
];

export function JobCostsPanel() {
  const recorded = useHopper((s) => s.recorded.machine);
  const [costs, setCosts] = useState<JobCosts | null>(null);
  const [by, setBy] = useState<JobCostGrouping>('kind');
  useEffect(() => { get<JobCosts>('/api/lanes/costs').then((c) => { if (c?.groups) setCosts(c); }, () => {}); }, [recorded]);
  const groups = costs?.groups[by] ?? [];
  const none = costs !== null && costs.groups.kind.length === 0;
  return (
    <Panel title="Job costs" icon={Receipt}>
      <div className="grid gap-3">
        <p className="text-xs text-muted-foreground">
          What a finished job costs its machine, from its runs over the last {costs?.windowDays ?? 30} days: one lane's share of CPU,
          memory and disk above the machine's idle use, and the plan usage it burned. The mean per group.
        </p>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Group job costs by">
          {GROUPINGS.map((g) => (
            <Button key={g.by} size="sm" variant={by === g.by ? 'default' : 'outline'} aria-pressed={by === g.by} onClick={() => setBy(g.by)}>{g.label}</Button>
          ))}
        </div>
        {costs === null ? <p className="text-sm text-muted-foreground">Loading…</p>
          : none || groups.length === 0 ? (
            <p data-slot="job-costs-empty" className="text-sm text-muted-foreground">
              {none ? `No finished job of the last ${costs.windowDays} days has a cost profile yet.` : GROUPINGS.find((g) => g.by === by)!.empty}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{GROUPINGS.find((g) => g.by === by)!.label}</TableHead>
                  <TableHead>Jobs</TableHead><TableHead>Duration</TableHead><TableHead>CPU</TableHead><TableHead>Memory</TableHead>
                  <TableHead>Disk</TableHead><TableHead>Usage</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map((g) => (
                  <TableRow key={g.key} data-slot="job-cost-group" className="num text-xs">
                    <TableCell className="font-medium">{g.key}</TableCell>
                    <TableCell>{groupJobsText(g)}</TableCell>
                    <TableCell>{durationText(g.durationMs)}</TableCell>
                    <TableCell>{cpuText(g.cpu)}</TableCell>
                    <TableCell>{bytesText(g.memoryBytes)}</TableCell>
                    <TableCell>{bytesText(g.diskBytes)}</TableCell>
                    <TableCell>{usageText(g.usage)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
      </div>
    </Panel>
  );
}
