// Access requests, Bastions (issue #2146, design.md "Bastions"): each bastion of a job that runs now — its template, its
// job, the targets it forwards to and when its TTL ends —, with Stop. A stop is a cancel, an operator's: the bastion
// ends as when its job stops it, its tokens released and its box burned; the job may ask for one again. Never a token.
import { CircleStop, Network } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Empty, Panel } from '@/components/panel';
import { post, SessionRejected } from '@/lib/api';
import type { BastionView, VaultView } from '@/model/wire';
import { useHopper } from '@/store';
import { viewAnswer } from '@/store/vault';

const minute = (iso: string): string => iso.slice(0, 16).replace('T', ' ');

export function Bastions({ view, can }: { view: VaultView | null; can: boolean }) {
  const [busy, setBusy] = useState(false);
  const bastions: BastionView[] = view?.bastions ?? [];
  const stop = async (b: BastionView): Promise<void> => {
    setBusy(true);
    try {
      await viewAnswer(() => post<VaultView>('/ui/api/bastions/stop', { job: b.jobId }));
      toast.success(`Bastion of ${b.template} stopped`);
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false });
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-access-panel="bastions">
      <Panel title="Bastions" icon={Network} count={bastions.length || ''} bodyClassName="space-y-3">
        <p className="text-sm text-muted-foreground">A bastion is the one sandbox of a job that outlives a step: it holds a port-forward to each of its targets, and the job reaches them through the hopper. It ends when its time passes with no use, when its job ends, or when it is stopped. Stop ends it now: its tokens stop working, and its box goes.</p>
        {bastions.length === 0 && <Empty>No bastion runs. When a job starts one, it shows here.</Empty>}
        {bastions.length > 0 && (
          <ul className="space-y-2">{bastions.map((b) => (
            <li key={b.id} data-bastion={b.id} className="space-y-1 rounded-md border p-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <Network className="size-4" />
                <span className="text-sm font-medium">{b.template}</span>
                <span className="text-muted-foreground">{b.state}</span>
                {can && <Button size="sm" variant="outline" disabled={busy} onClick={() => void stop(b)}><CircleStop />Stop</Button>}
              </div>
              <p className="text-muted-foreground">Job: <a href={`#job/${b.jobId}`} className="font-mono underline">{b.jobId.slice(0, 8)}</a> · started {minute(b.startedAt)} · ends {minute(b.expiresAt)} unless used</p>
              <ul className="font-mono break-all">{b.targets.map((t) => <li key={t.target}>{t.target}</li>)}</ul>
            </li>
          ))}</ul>
        )}
      </Panel>
    </div>
  );
}
