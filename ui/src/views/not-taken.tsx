// Not taken (issue #798): every open labelled issue a source listed and did not take, per source, grouped by why with a
// count per group — request cards waiting for approval first, with Approve; then not assigned to you, on the backburner
// (with Take off the backburner), its pull request waits for review, partly done, and the other reasons. The nav badge
// counts the request cards. Sources keeps the full intake, the taken issues included. An issue approved here stays in its
// place, taken or not, until the view closes (issue #811).
import { Inbox } from 'lucide-react';
import { IntakeGroups } from '@/components/intake-groups';
import { Empty, Panel } from '@/components/panel';
import { intakeOf } from '@/model/intake';
import { useHopper } from '@/store';
import { keepsPlace, useApprovals } from '@/store/intake';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function NotTaken() {
  const sources = useHopper((s) => s.sources);
  const approvals = useApprovals();
  const listed = sources.map((s) => ({ s, items: intakeOf(s).filter((x) => x.reason !== undefined || keepsPlace(approvals[x.key])) }))
    .filter((x) => x.items.length > 0);
  if (listed.length === 0) return <Panel title="Not taken" icon={Inbox}><Empty>every open labelled issue the sources listed is taken</Empty></Panel>;
  return (
    <div className="space-y-4">
      {listed.map(({ s, items }) => (
        <Panel key={s.name} title={s.name} icon={Inbox} bodyClassName="space-y-2 text-xs">
          <div data-not-taken={s.name} className="space-y-2">
            <p className="text-muted-foreground">{plural(items.length, 'open labelled issue')} not taken, as of the last sync</p>
            <IntakeGroups items={items} source={s.name} taken={false} />
          </div>
        </Panel>
      ))}
    </div>
  );
}
