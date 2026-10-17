// The leftovers on a Machines card (issue #1116, design.md "Leftovers a person decides"): old job files and repository mirrors
// the sweep does not remove by itself, each with its size, its age and whether it holds work not pushed. A person keeps or
// removes each one (POST /ui/api/machines/leftovers).
import { useState } from 'react';
import { Confirm } from '@/components/confirm';
import { StatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { leftoverText, removalText } from '@/model/leftovers';
import type { MachineView } from '@/model/wire';
import { act } from '@/store';

export function MachineLeftovers({ m, canAct }: { m: MachineView; canAct: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const items = m.leftovers?.items ?? [];
  if (items.length === 0) return null;
  const decide = async (path: string, decision: 'keep' | 'remove') => {
    setBusy(path);
    try {
      await act('/ui/api/machines/leftovers', { machineId: m.id, path, decision }, decision === 'keep' ? 'Kept' : 'Removed');
    } finally {
      setBusy(null);
    }
  };
  return (
    <section aria-label="Leftovers" data-slot="leftovers" className="grid gap-1.5 text-sm">
      <p className="font-medium">Leftovers to decide on</p>
      <p className="text-xs text-muted-foreground">
        Old job files and repository mirrors from an older hopper layout. The sweep does not remove them by itself: they may be another
        hopper's or a test's, or old jobs still use them. Keep or remove each one.
      </p>
      <ul className="grid gap-2">
        {items.map((l) => (
          <li key={l.path} className="grid gap-1 rounded-md border p-2">
            <code className="font-mono text-xs break-all">{l.path}</code>
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span>{leftoverText(l)}</span>
              {l.unpushed && <StatusBadge status="work not pushed" tone="warn" />}
              {l.kept && <StatusBadge status="kept" tone="muted" />}
            </div>
            {canAct && (
              <div className="flex flex-wrap gap-2">
                {!l.kept && <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void decide(l.path, 'keep')}>Keep</Button>}
                <Confirm title="Remove this leftover?" action="Remove" description={removalText(l)} onConfirm={() => void decide(l.path, 'remove')}>
                  <Button size="sm" variant="outline" disabled={busy !== null} aria-label={`Remove ${l.path}`}>Remove</Button>
                </Confirm>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
