// Sandboxes jobs start (issue #991). Access requests, **Sandbox runs**: the boxes jobs asked for — a run that waits for a
// person, with the job, the template and its blast radius, Approve (the box starts) and Decline (with the reason the job
// is told); then the runs that start, run, were declined or failed. Settings → Vault, **Sandbox approvals**: the two
// toggles that skip a person, and YOLO, both. Approving and the toggles are an admin's.
import { Boxes, Check, Rocket, TriangleAlert, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Confirm } from '@/components/confirm';
import { Empty, Panel } from '@/components/panel';
import { TemplateRadiusBadge } from '@/components/template-radius';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { post, RoleRefused, SessionRejected } from '@/lib/api';
import { sandboxApprovalsText, sandboxRunsWaiting } from '@/model/vault';
import type { SandboxApprovals as Approvals, SandboxRequestView, TemplateView, VaultView } from '@/model/wire';
import { useHopper } from '@/store';
import { setVaultView, useVaultStore } from '@/store/vault';

/** Posts one sandbox change and keeps the vault's view it answers. */
async function sendSandbox(path: string, body: unknown, done: string): Promise<boolean> {
  useVaultStore.setState({ busy: true });
  try {
    setVaultView(await post<VaultView>(path, body));
    toast.success(done);
    return true;
  } catch (e) {
    if (e instanceof SessionRejected) useHopper.setState({ authed: false });
    toast.error(e instanceof RoleRefused ? 'Only an admin does this' : (e as Error).message);
    return false;
  } finally {
    useVaultStore.setState({ busy: false });
  }
}

const STATE_TEXT: Record<SandboxRequestView['state'], string> = {
  waiting: 'waits for a person', starting: 'starts now', running: 'runs', declined: 'declined', failed: 'did not start',
};

function Waiting({ r, template, can, busy }: { r: SandboxRequestView; template?: TemplateView; can: boolean; busy: boolean }) {
  const [reason, setReason] = useState('');
  return (
    <li data-sandbox-request={r.id} className="space-y-2 rounded-md border border-warn/50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Boxes className="size-4 text-warn" />
        <span className="font-mono text-sm font-medium break-all">{r.template}</span>
        {template && <TemplateRadiusBadge radius={template.radius} />}
        <span className="text-xs text-warn">{STATE_TEXT[r.state]}</span>
      </div>
      <p className="text-xs text-muted-foreground break-words">Job <a href={`#jobs/${r.jobId}`} className="font-mono underline">{r.jobId.slice(0, 8)}</a>{r.jobTitle ? <>: {r.jobTitle}</> : null}, asked at {r.askedAt}.</p>
      {can ? (
        <div className="flex flex-wrap items-center gap-2">
          <Confirm title={`Start a box of ${r.template}?`} action="Approve" onConfirm={() => void sendSandbox('/ui/api/sandbox-requests', { action: 'approve', id: r.id }, `${r.template}: the box starts`)}
            description={<>The hopper starts a sandbox box of <span className="font-mono">{r.template}</span> with its defaults. It joins as a machine and gets what the template is approved for{template?.radius ? <>, blast radius {template.radius.level}</> : null}.</>}>
            <Button size="sm" disabled={busy}><Check />Approve</Button>
          </Confirm>
          <Input className="h-8 max-w-64 text-sm" placeholder="Why not (the job is told)" value={reason} onChange={(e) => setReason(e.target.value)} aria-label={`Why not start ${r.template}`} />
          <Button size="sm" variant="outline" disabled={busy || reason.trim() === ''} onClick={() => void sendSandbox('/ui/api/sandbox-requests', { action: 'decline', id: r.id, reason: reason.trim() }, `${r.template}: declined`)}><X />Decline</Button>
        </div>
      ) : <p className="text-xs text-muted-foreground">An admin approves it here.</p>}
    </li>
  );
}

/** Access requests, Sandbox runs (issue #991). Always rendered: with none, it says what will show here. */
export function SandboxRuns({ view, can, busy }: { view: VaultView | null; can: boolean; busy: boolean }) {
  const all = view?.sandboxRequests ?? [];
  const waiting = sandboxRunsWaiting(view);
  const rest = all.filter((r) => r.state !== 'waiting');
  const templates = view?.templates ?? [];
  return (
    <div data-access-panel="sandbox-runs">
      <Panel title="Sandbox runs" icon={Rocket} count={waiting.length || ''} bodyClassName="space-y-3">
        <p className="text-sm text-muted-foreground">A job asks the hopper for a sandbox, and the hopper starts the box. Each run waits here for a person, unless <a href="#settings/vault" className="underline">skip sandbox approval</a> is on.</p>
        {waiting.length === 0 ? <Empty>No sandbox run waits. A run a job asks for waits here.</Empty>
          : <ul className="space-y-2">{waiting.map((r) => <Waiting key={r.id} r={r} template={templates.find((t) => t.name === r.template)} can={can} busy={busy} />)}</ul>}
        {rest.length > 0 && (
          <ul className="space-y-1 text-xs">
            {rest.map((r) => (
              <li key={r.id} data-sandbox-request={r.id} className="break-words">
                <span className="font-mono">{r.template}</span> for job <a href={`#jobs/${r.jobId}`} className="font-mono underline">{r.jobId.slice(0, 8)}</a>: {STATE_TEXT[r.state]}
                {r.container ? <> as <span className="font-mono">{r.container}</span></> : null}{r.approvedBy ? <>, approved by {r.approvedBy}</> : null}{r.reason ? <> — {r.reason}</> : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

/** Settings → Vault, Sandbox approvals (issue #991): skip template approval, skip sandbox approval, and YOLO, both. */
export function SandboxApprovals({ approvals, can, busy }: { approvals: Approvals | undefined; can: boolean; busy: boolean }) {
  const a = approvals ?? { skipTemplateApproval: false, skipSandboxApproval: false };
  const yolo = a.skipTemplateApproval && a.skipSandboxApproval;
  const set = (edit: Partial<Approvals> & { yolo?: boolean }, done: string) => void sendSandbox('/ui/api/sandbox-approvals', edit, done);
  const row = (label: string, hint: string, checked: boolean, onChange: (on: boolean) => void) => (
    <label className="flex items-start gap-2">
      <Switch className="mt-0.5" checked={checked} disabled={!can || busy} aria-label={label} onCheckedChange={onChange} />
      <span><span className="font-medium">{label}</span><span className="block text-xs text-muted-foreground">{hint}</span></span>
    </label>
  );
  return (
    <div data-slot="sandbox-approvals">
      <Panel title="Sandbox approvals" icon={Rocket} bodyClassName="space-y-3 text-sm">
        <p className="text-sm text-muted-foreground">Jobs start their own sandboxes: a job asks, the hopper makes or reuses the template, and starts the box. {sandboxApprovalsText(approvals)}</p>
        {yolo && (
          <p role="note" className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
            <TriangleAlert className="size-4 shrink-0 text-amber-600" />Nobody approves anything: a job can get write, sync or apply on any asset it names. Each approval is still an event that names the toggle.
          </p>
        )}
        {row('YOLO', 'Both below: a job gets its sandbox with no person.', yolo, (on) => set({ yolo: on }, on ? 'YOLO is on' : 'YOLO is off'))}
        {row('Skip template approval', 'A new template a job asks for is approved at once, its write, sync and apply profiles too.', a.skipTemplateApproval, (on) => set({ skipTemplateApproval: on }, 'Saved'))}
        {row('Skip sandbox approval', 'A sandbox run starts the moment a job asks, a high-blast-radius one too.', a.skipSandboxApproval, (on) => set({ skipSandboxApproval: on }, 'Saved'))}
        {!can && <p className="text-xs text-muted-foreground">An admin changes these.</p>}
      </Panel>
    </div>
  );
}
