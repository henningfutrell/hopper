// Access requests, Vault grants (issue #652, design.md "Vault grants"; on Access requests since issue #897): a job on a box, or a job's
// Windows sandbox step (issue #731), gets nothing from the vault until a person grants it the vault. A job that asked with no grant is a card —
// its box and template, or the Windows host, and what it asked for — with
// "Grant this job the vault"; the grant is kept for the job's item, so Run again and Rework keep it. A granted item says
// who granted it, and Revoke takes it back. A job asks; only a person grants, and Access decides. Least role: operator.
// With none, the panel says what will show here. Each grant names what it covers (issue #1124): the item's title, repository
// and link, its newest job's status, the date granted, and how it was made — the operator CLI's command when it was made
// there. A grant whose item has no job waiting or at work is flagged stale: it gives nothing now, and Revoke takes it back.
// Issue #1138: Deny drops an ask, and that job asks no more; a grant says when it was made to the minute, and a delegate
// approver's names the delegate and the person it acted for.
import { Ban, KeyRound, ShieldCheck, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Empty, Panel } from '@/components/panel';
import { post, SessionRejected } from '@/lib/api';
import { StatusBadge } from '@/components/status';
import type { VaultGrantItem, VaultGrantView, VaultView } from '@/model/wire';
import { useHopper } from '@/store';
import { viewAnswer } from '@/store/vault';
import { useCanOperate } from '@/store/selectors';

export function VaultGrants({ view }: { view: VaultView | null }) {
  const can = useCanOperate();
  const [busy, setBusy] = useState(false);
  const asks = view?.grantAsks ?? [];
  const grants = view?.grants ?? [];
  const act = async (job: string, what: 'grant-vault' | 'deny-vault' | 'revoke-vault', done: string): Promise<void> => {
    setBusy(true);
    try {
      await viewAnswer(() => post<VaultView>(`/ui/api/jobs/${encodeURIComponent(job)}/${what}`, {}));
      toast.success(done);
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false });
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-access-panel="grants">
      <Panel title="Vault grants" icon={ShieldCheck} count={asks.length || ''} bodyClassName="space-y-3">
        <p className="text-sm text-muted-foreground">A job on a box, or a job's Windows step, gets no vault secret and no minted credential until you grant it the vault. A grant covers the job's item, so Run again and Rework keep it; the box's template, or the Windows host, still limits what it gets.</p>
        {asks.length === 0 && grants.length === 0 && <Empty>No job waits for a vault grant. When a job on a box, or a Windows step, asks the vault with no grant, it waits here.</Empty>}
        {asks.length > 0 && (
          <ul className="space-y-2">{asks.map((a) => (
            <li key={a.job} className="space-y-2 rounded-md border border-warn/50 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <KeyRound className="size-4 text-warn" />
                <span className="text-sm font-medium">Grant this job the vault</span>
                <span className="text-xs text-muted-foreground">job {a.job.slice(0, 8)} {a.windowsHost ? `for a step on the Windows host ${a.windowsHost}` : a.box ? `for a box step of template ${a.template ?? 'a template'}` : `on ${a.machine ?? 'a box'}, a box of ${a.template ?? 'a template'}`}</span>
              </div>
              <p className="text-xs break-words">Asked for: <span className="font-mono">{a.names.join(', ')}</span></p>
              <p className="text-xs text-muted-foreground break-all">Item: {a.item ? <ItemName item={a.item} /> : a.key}</p>
              {can && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={busy} onClick={() => void act(a.job, 'grant-vault', `job ${a.job.slice(0, 8)}: granted the vault`)}><ShieldCheck />Grant</Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(a.job, 'deny-vault', `job ${a.job.slice(0, 8)}: denied; it asks no more`)}><Ban />Deny</Button>
                </div>
              )}
            </li>
          ))}</ul>
        )}
        {grants.length > 0 && (
          <ul className="space-y-2">{grants.map((g) => (
            <li key={g.key} className="space-y-1 rounded-md border p-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <ItemName item={g.item} />
                {g.item.status && <StatusBadge status={g.item.status} />}
                {g.item.stale && <StatusBadge status="stale" label="Stale" tone="warn" title="No job of this item waits or is at work: the grant gives nothing now. Revoke it." />}
                {can && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(g.job, 'revoke-vault', 'vault grant revoked')}><Undo2 />Revoke</Button>}
              </div>
              <p className="text-muted-foreground">{grantedHow(g)}</p>
            </li>
          ))}</ul>
        )}
      </Panel>
    </div>
  );
}

/** An item by its title, linked to its issue or pull request; its repository, and its newest job by its short id. */
function ItemName({ item }: { item: VaultGrantItem }) {
  return (
    <span className="break-words">
      {item.url ? <a href={item.url} target="_blank" rel="noreferrer" className="font-medium underline-offset-2 hover:underline">{item.title}</a> : <span className="font-medium">{item.title}</span>}
      {item.repo && <span className="text-muted-foreground"> · {item.repo}</span>}
      {item.job && <span className="text-muted-foreground"> · job {item.job.slice(0, 8)}</span>}
    </span>
  );
}

/** Who granted it, on which day, and the way: a direct job's submission, or the operator CLI's command. */
function grantedHow(g: VaultGrantView): string {
  const when = `on ${g.at.slice(0, 10)} ${g.at.slice(11, 16)} UTC`;
  const how = g.made === 'submit' ? 'when the direct job was submitted with the vault authorization' : '';
  const cli = g.via === 'cli' && g.command ? `through the operator CLI (\`${g.command}\`, run on the hopper's host with the database's credentials)` : '';
  const by = g.via === 'cli' ? '' : `by ${g.by}`;
  return ['granted', by, how, cli, when].filter(Boolean).join(' ');
}
