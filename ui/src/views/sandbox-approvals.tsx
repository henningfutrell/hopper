// Sandboxes jobs start (issue #991). Access requests, **Sandbox runs**: the boxes jobs asked for — a run that waits for a
// person, with the job, the template and its blast radius, Approve (the box starts) and Decline (with the reason the job
// is told); then the runs that start, run, were declined or failed. Settings → Vault, **Sandbox approvals**: the two
// toggles that skip a person, and YOLO, both. Approving and the toggles are an admin's.
// Issue #1001: each run card decides on its own — while its approval is pending, only it says so, and the others stay
// clickable; the box starts in the background. Settings → Vault also sets the auto-approve policy, per blast radius level.
import { Boxes, Check, Loader2, Rocket, TriangleAlert, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Confirm } from '@/components/confirm';
import { Empty, Panel } from '@/components/panel';
import { TemplateRadiusBadge } from '@/components/template-radius';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { post, RoleRefused, SessionRejected } from '@/lib/api';
import { autoApproveOf, profileText, rememberedKey, sandboxApprovalsText, sandboxRunsWaiting } from '@/model/vault';
import type { SandboxApprovals as Approvals, RememberedWriteView, SandboxRequestView, TemplateView, VaultSecret, VaultView } from '@/model/wire';
import { SandboxAsk } from './sandbox-ask';
import { useHopper } from '@/store';
import { useVaultStore, viewAnswer } from '@/store/vault';

/** Posts one sandbox change and keeps the vault's view it answers. `quiet`: a card's own decision, which marks nothing else busy. */
async function sendSandbox(path: string, body: unknown, done: string, quiet = false): Promise<boolean> {
  if (!quiet) useVaultStore.setState({ busy: true });
  try {
    await viewAnswer(() => post<VaultView>(path, body));
    toast.success(done);
    return true;
  } catch (e) {
    if (e instanceof SessionRejected) useHopper.setState({ authed: false });
    toast.error(e instanceof RoleRefused ? 'Only an admin does this' : (e as Error).message);
    return false;
  } finally {
    if (!quiet) useVaultStore.setState({ busy: false });
  }
}

const STATE_TEXT: Record<SandboxRequestView['state'], string> = {
  waiting: 'waits for a person', starting: 'starts now', running: 'runs', declined: 'declined', failed: 'did not start',
};

function Waiting({ r, template, secrets, can }: { r: SandboxRequestView; template?: TemplateView | undefined; secrets: readonly VaultSecret[]; can: boolean }) {
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState<'approve' | 'decline' | null>(null);
  const decide = (what: 'approve' | 'decline', body: unknown, done: string): void => {
    setPending(what);
    void sendSandbox('/ui/api/sandbox-requests', body, done, true).finally(() => setPending(null));
  };
  return (
    <li data-sandbox-request={r.id} className="space-y-2 rounded-md border border-warn/50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Boxes className="size-4 text-warn" />
        {template?.label && <span className="text-sm font-medium break-all">{template.label}</span>}
        <span className={template?.label ? 'font-mono text-xs text-muted-foreground break-all' : 'font-mono text-sm font-medium break-all'}>{r.template}</span>
        {template && <TemplateRadiusBadge radius={template.radius} />}
        <span className="text-xs text-warn">{STATE_TEXT[r.state]}</span>
      </div>
      <SandboxAsk purpose={r.purpose} plan={r.plan} job={{ id: r.jobId, title: r.jobTitle, url: r.jobUrl }} needs={template?.profiles} secrets={secrets} />
      <p className="text-xs text-muted-foreground">Asked at {r.askedAt}.</p>
      {can ? (
        <div className="flex flex-wrap items-center gap-2">
          <Confirm title={`Start a box of ${r.template}?`} action="Approve" onConfirm={() => decide('approve', { action: 'approve', id: r.id }, `${r.template}: the box starts`)}
            description={<>The hopper starts a sandbox box of <span className="font-mono">{r.template}</span> with its defaults. It joins as a machine and gets what the template is approved for{template?.radius ? <>, blast radius {template.radius.level}</> : null}.</>}>
            <Button size="sm" disabled={pending !== null}><Check />Approve</Button>
          </Confirm>
          <Input className="h-8 max-w-64 text-sm" placeholder="Why not (the job is told)" value={reason} onChange={(e) => setReason(e.target.value)} aria-label={`Why not start ${r.template}`} />
          <Button size="sm" variant="outline" disabled={pending !== null || reason.trim() === ''} onClick={() => decide('decline', { action: 'decline', id: r.id, reason: reason.trim() }, `${r.template}: declined`)}><X />Decline</Button>
          {pending && <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" />{pending === 'approve' ? 'Approving…' : 'Declining…'}</span>}
        </div>
      ) : <p className="text-xs text-muted-foreground">An admin approves it here.</p>}
    </li>
  );
}

/** Access requests, Sandbox runs (issue #991). Always rendered: with none, it says what will show here. */
export function SandboxRuns({ view, can }: { view: VaultView | null; can: boolean }) {
  const all = view?.sandboxRequests ?? [];
  const waiting = sandboxRunsWaiting(view);
  const rest = all.filter((r) => r.state !== 'waiting');
  const templates = view?.templates ?? [];
  return (
    <div data-access-panel="sandbox-runs">
      <Panel title="Sandbox runs" icon={Rocket} count={waiting.length || ''} bodyClassName="space-y-3">
        <p className="text-sm text-muted-foreground">A job asks the hopper for a sandbox, and the hopper starts the box. A run waits here for a person unless <a href="#settings/vault" className="underline">the auto-approve policy</a> holds its blast radius, skip sandbox approval is on, or a person approved the template the job asked for.</p>
        {waiting.length === 0 ? <Empty>No sandbox run waits. A run a job asks for waits here.</Empty>
          : <ul className="space-y-2">{waiting.map((r) => <Waiting key={r.id} r={r} template={templates.find((t) => t.name === r.template)} secrets={view?.secrets ?? []} can={can} />)}</ul>}
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

const LEVELS = ['low', 'medium', 'high'] as const;
const LEVEL_HINT: Record<typeof LEVELS[number], string> = {
  low: 'Read only, no vault secret.',
  medium: 'A vault secret whose reach the hopper cannot see, or a read on prod.',
  high: 'Write, sync or apply on an asset.',
};

/**
 * Remembered write approvals (issue #1001): each write, sync or apply a person approved, remembered for its asset and
 * access until it ends or an admin forgets it; and the time limit, in hours (0: until forgotten).
 */
function Remembered({ remembered, hours, can, busy }: { remembered: readonly RememberedWriteView[]; hours: number; can: boolean; busy: boolean }) {
  const [said, setSaid] = useState(String(hours));
  const n = Number(said);
  const valid = said.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= 8760;
  return (
    <>
      <p className="pt-1 font-medium">Remembered write approvals</p>
      <p className="text-xs text-muted-foreground">A write, sync or apply a person approves is remembered for that asset. A later template or sandbox run whose every change is remembered, and whose reads need no person, is approved with no person. Each approval is an event that names a remembered write approval.</p>
      <div className="flex flex-wrap items-center gap-2">
        <Input className="h-8 w-24 text-sm" inputMode="numeric" aria-label="Remember write approvals for (hours)" value={said} disabled={!can || busy} onChange={(e) => setSaid(e.target.value)} />
        <span className="text-xs text-muted-foreground">hours (0: until forgotten)</span>
        <Button size="sm" variant="outline" disabled={!can || busy || !valid || n === hours} onClick={() => void sendSandbox('/ui/api/sandbox-approvals', { rememberWritesHours: n }, 'Saved')}>Save time limit</Button>
      </div>
      {remembered.length === 0 ? <p className="text-xs text-muted-foreground">None is remembered. A write a person approves shows here.</p> : (
        <ul className="space-y-1 text-xs">
          {remembered.map((w) => (
            <li key={rememberedKey(w)} data-remembered-write={rememberedKey(w)} className="flex flex-wrap items-center gap-2">
              <span className="font-mono break-all">{profileText(w)}</span>
              <span className="text-muted-foreground">approved by {w.by}, {w.expiresAt ? `until ${w.expiresAt}` : 'until forgotten'}</span>
              {can && <Button size="sm" variant="outline" className="h-7" disabled={busy} onClick={() => void sendSandbox('/ui/api/sandbox-approvals', { forgetWrite: { operation: w.operation, asset: w.asset } }, `${profileText(w)}: forgotten`)}>Forget</Button>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Settings → Vault, Sandbox approvals (issue #991): skip template approval, skip sandbox approval, and YOLO, both; the auto-approve policy and the remembered write approvals (issue #1001). */
export function SandboxApprovals({ approvals, remembered, can, busy }: { approvals: Approvals | undefined; remembered: readonly RememberedWriteView[]; can: boolean; busy: boolean }) {
  const a = approvals ?? { skipTemplateApproval: false, skipSandboxApproval: false };
  const auto = autoApproveOf(approvals);
  const yolo = a.skipTemplateApproval && a.skipSandboxApproval;
  type Edit = Omit<Partial<Approvals>, 'autoApprove' | 'rememberWritesHours'> & { yolo?: boolean; autoApprove?: Partial<NonNullable<Approvals['autoApprove']>> };
  const set = (edit: Edit, done: string) => void sendSandbox('/ui/api/sandbox-approvals', edit, done);
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
        <p className="pt-1 font-medium">Auto-approve by blast radius</p>
        <p className="text-xs text-muted-foreground">A new template a job asks for, and a sandbox run, of a level on here is approved with no person. Each approval is an event that names the auto-approve policy.</p>
        {LEVELS.map((l) => row(`Auto-approve ${l} radius`, LEVEL_HINT[l], auto[l], (on) => set({ autoApprove: { [l]: on } }, 'Saved')))}
        <Remembered remembered={remembered} hours={a.rememberWritesHours ?? 168} can={can} busy={busy} />
        {!can && <p className="text-xs text-muted-foreground">An admin changes these.</p>}
      </Panel>
    </div>
  );
}
