// The machine's terminal on its Machines card (issue #1128): an admin lists the panes of the hopper's herdr session on the
// machine — a pane a job holds names its job —, picks one, sees its screen read again every 1.5 s and types into it,
// through the hopper (POST /ui/api/machines/:id/terminal/*), from anywhere the UI reaches. Access decides each use; the
// daemon audits the session and never keeps the text.
import { RefreshCw, SquareTerminal, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { post } from '@/lib/api';
import { PaneTerminal } from './pane-terminal';

interface Pane { paneId: string; tabId: string; title?: string; agent?: string; agentStatus: string; jobId?: string }

/** What a pane's button says: its title, else its agent, else its id; and the job that holds it. */
const paneLabel = (p: Pane): string => `${p.title ?? p.agent ?? p.paneId}${p.jobId ? ` · job ${p.jobId}` : ''}`;

export function MachineTerminal({ machineId, onClose }: { machineId: string; onClose: () => void }) {
  const base = `/ui/api/machines/${encodeURIComponent(machineId)}/terminal`;
  const [panes, setPanes] = useState<Pane[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [paneId, setPaneId] = useState<string | undefined>();
  /** Bumped by List again: the panes are read again. */
  const [round, setRound] = useState(0);
  useEffect(() => {
    let stop = false;
    void (async () => {
      try {
        const r = await post<{ panes: Pane[] }>(`${base}/panes`, {});
        if (!stop) { setPanes(r.panes); setError(undefined); }
      } catch (e) {
        if (!stop) setError((e as Error).message);
      }
    })();
    return () => { stop = true; };
  }, [base, round]);

  return (
    <div data-slot="machine-terminal" className="space-y-2 rounded-md border p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <SquareTerminal className="size-4" />The hopper&apos;s herdr session
        <span className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => setRound((n) => n + 1)} aria-label="List the panes again"><RefreshCw /></Button>
          <Button size="sm" variant="ghost" onClick={onClose}><X />Close</Button>
        </span>
      </div>
      <p className="text-xs text-muted-foreground">Pick a pane to view it and type into it. What you type goes to the machine as you type it; a pane no job holds may be a shell.</p>
      {error && <div className="text-xs text-bad">{error}</div>}
      {panes && panes.length === 0 && <div className="text-xs text-muted-foreground">no panes in the session</div>}
      <div className="flex flex-wrap gap-1">
        {panes?.map((p) => (
          <Button key={p.paneId} size="sm" variant={p.paneId === paneId ? 'default' : 'outline'} aria-pressed={p.paneId === paneId} onClick={() => setPaneId(p.paneId)}>{paneLabel(p)}</Button>
        ))}
      </div>
      {paneId && <PaneTerminal key={paneId} base={base} with={{ paneId }} />}
    </div>
  );
}
