// Settings → Vault, Vault grants (issue #652, design.md "Vault grants"): a job on a box gets nothing from the vault until a
// person grants it the vault. A job that asked with no grant is a card — its box and template, what it asked for — with
// "Grant this job the vault"; the grant is kept for the job's item, so Run again and Rework keep it. A granted item says
// who granted it, and Revoke takes it back. A job asks; only a person grants, and Access decides. Least role: operator.
import { KeyRound, ShieldCheck, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/panel';
import { post, SessionRejected } from '@/lib/api';
import type { VaultView } from '@/model/wire';
import { useHopper } from '@/store';
import { useCanOperate } from '@/store/selectors';

export function VaultGrants({ view, onView }: { view: VaultView; onView: (v: VaultView) => void }) {
  const can = useCanOperate();
  const [busy, setBusy] = useState(false);
  const asks = view.grantAsks ?? [];
  const grants = view.grants ?? [];
  if (asks.length === 0 && grants.length === 0) return null;
  const act = async (job: string, what: 'grant-vault' | 'revoke-vault', done: string): Promise<void> => {
    setBusy(true);
    try {
      onView(await post<VaultView>(`/ui/api/jobs/${encodeURIComponent(job)}/${what}`, {}));
      toast.success(done);
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false });
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Vault grants" icon={ShieldCheck} count={asks.length || ''} bodyClassName="space-y-3">
      <p className="text-sm text-muted-foreground">A job on a box gets no vault secret and no minted credential until you grant it the vault. A grant covers the job's item, so Run again and Rework keep it; the box's template still limits what it gets.</p>
      {asks.length > 0 && (
        <ul className="space-y-2">{asks.map((a) => (
          <li key={a.job} className="space-y-2 rounded-md border border-warn/50 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <KeyRound className="size-4 text-warn" />
              <span className="text-sm font-medium">Grant this job the vault</span>
              <span className="text-xs text-muted-foreground">job {a.job.slice(0, 8)} on {a.machine}, a box of {a.template}</span>
            </div>
            <p className="text-xs break-words">Asked for: <span className="font-mono">{a.names.join(', ')}</span></p>
            <p className="text-xs text-muted-foreground break-all">Item: {a.key}</p>
            {can && <Button size="sm" disabled={busy} onClick={() => void act(a.job, 'grant-vault', `job ${a.job.slice(0, 8)}: granted the vault`)}><ShieldCheck />Grant</Button>}
          </li>
        ))}</ul>
      )}
      {grants.length > 0 && (
        <ul className="space-y-1">{grants.map((g) => (
          <li key={g.key} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="break-all">{g.key}</span>
            <span className="text-muted-foreground">granted by {g.by}</span>
            {can && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(g.job, 'revoke-vault', 'vault grant revoked')}><Undo2 />Revoke</Button>}
          </li>
        ))}</ul>
      )}
    </Panel>
  );
}
