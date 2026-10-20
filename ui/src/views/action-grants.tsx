// Access requests, AWS actions (issue #2206, design.md "Action grants"): a job's need step whose AWS change needs an
// action the role's own access does not give asks for exactly that — the role, the action and the resource. Each ask is a
// card with Grant and Decline; a grant covers later asks of the same scope until the time limit of remembered write
// approvals, and Revoke takes it back. A person's act: an admin's, as a sandbox run's approval is.
import { Ban, CloudCog, ShieldCheck, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Empty, Panel } from '@/components/panel';
import { post, SessionRejected } from '@/lib/api';
import type { ActionAskView, ActionGrantView, VaultView } from '@/model/wire';
import { useHopper } from '@/store';
import { viewAnswer } from '@/store/vault';

const scopeOf = (a: { role: string; action: string; resource: string }) => ({ role: a.role, action: a.action, resource: a.resource });
const day = (iso: string): string => iso.slice(0, 16).replace('T', ' ');

export function ActionGrants({ view, can }: { view: VaultView | null; can: boolean }) {
  const [busy, setBusy] = useState(false);
  const asks: ActionAskView[] = view?.actionAsks ?? [];
  const grants: ActionGrantView[] = view?.actionGrants ?? [];
  const send = async (path: string, body: Record<string, unknown>, done: string): Promise<void> => {
    setBusy(true);
    try {
      await viewAnswer(() => post<VaultView>(path, body));
      toast.success(done);
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false });
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-access-panel="actions">
      <Panel title="AWS actions" icon={CloudCog} count={asks.length || ''} bodyClassName="space-y-3">
        <p className="text-sm text-muted-foreground">A job's step that changes AWS asks here for an action the role's own access does not give. Grant it, and the step's session reads and does only the granted actions on their resources. A grant covers later steps of the same role, action and resource until the time limit of remembered write approvals. The step still needs its approved plan.</p>
        {asks.length === 0 && grants.length === 0 && <Empty>No job waits for an AWS action. When a step needs one, it waits here.</Empty>}
        {asks.length > 0 && (
          <ul className="space-y-2">{asks.map((a) => (
            <li key={`${a.job} ${a.role} ${a.action} ${a.resource}`} data-action-ask="" className="space-y-2 rounded-md border border-warn/50 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <CloudCog className="size-4 text-warn" />
                <span className="text-sm font-medium font-mono">{a.action}</span>
                <span className="text-xs text-muted-foreground">as aws-role {a.role}</span>
              </div>
              <p className="text-xs break-all">On: <span className="font-mono">{a.resource}</span></p>
              <p className="text-xs text-muted-foreground break-words">Job: {a.jobUrl ? <a href={a.jobUrl} className="underline">{a.jobTitle ?? a.job.slice(0, 8)}</a> : (a.jobTitle ?? a.job.slice(0, 8))} · asked {day(a.at)}</p>
              {a.why && <p className="text-xs break-words">Why: {a.why}</p>}
              {can && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={busy} onClick={() => void send('/ui/api/sandbox-requests', { action: 'grant-action', job: a.job, grant: scopeOf(a) }, `${a.action}: granted`)}><ShieldCheck />Grant</Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void send('/ui/api/sandbox-requests', { action: 'decline-action', job: a.job, grant: scopeOf(a) }, `${a.action}: declined; the step is told no`)}><Ban />Decline</Button>
                </div>
              )}
            </li>
          ))}</ul>
        )}
        {grants.length > 0 && (
          <ul className="space-y-2">{grants.map((g) => (
            <li key={`${g.role} ${g.action} ${g.resource}`} data-action-grant="" className="space-y-1 rounded-md border p-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{g.action}</span>
                <span className="text-muted-foreground">as aws-role {g.role}</span>
                {can && <Button size="sm" variant="outline" disabled={busy} onClick={() => void send('/ui/api/sandbox-approvals', { revokeAction: scopeOf(g) }, `${g.action}: grant revoked`)}><Undo2 />Revoke</Button>}
              </div>
              <p className="break-all font-mono">{g.resource}</p>
              <p className="text-muted-foreground">granted by {g.by} at {day(g.at)}{g.expiresAt ? `, ends ${day(g.expiresAt)}` : ', until revoked'}</p>
            </li>
          ))}</ul>
        )}
      </Panel>
    </div>
  );
}
