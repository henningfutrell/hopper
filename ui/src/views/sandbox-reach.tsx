// The sandbox boxes that cannot reach the hopper (issue #708): each box's start check runs in the box at every reconcile
// pass; a box whose check fails is `unreachable`, never ready, and is shown here with what the check wrote.
import { Unplug } from 'lucide-react';
import { Panel } from '@/components/panel';
import type { SandboxesView } from '@/model/wire';

export function UnreachableBoxes({ view }: { view: SandboxesView | null }) {
  const boxes = (view?.boxes ?? []).filter((b) => b.state === 'unreachable');
  if (!boxes.length) return null;
  return (
    <Panel title="Sandbox boxes that cannot reach the hopper" icon={Unplug}>
      <div role="alert" className="grid gap-2 text-sm">
        <p className="text-xs text-muted-foreground">From inside each box, the hopper does not answer at the address the box was given. The hopper checks again every few seconds. Its jobs wait until it reaches the hopper again.</p>
        <ul className="grid gap-1.5">
          {boxes.map((b) => (
            <li key={b.name} data-unreachable-box className="text-xs break-words">
              <span className="font-mono font-medium text-foreground">{b.name}</span>
              <span className="text-muted-foreground"> at <code className="font-mono">{b.address}</code></span>
              <span className="text-destructive">: {b.check?.output ?? 'its start check failed'}</span>
              {b.check && <span className="text-muted-foreground"> (since {new Date(b.check.at).toLocaleTimeString()})</span>}
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}
