// Sandboxes jobs start (issue #991). Access requests, **Sandbox runs**: the boxes jobs asked for — a run that waits for a
// person, with the job, the template and its blast radius, Approve (the box starts) and Decline (with the reason the job
// is told); then the runs that start, run, were declined or failed. Vault, **Sandbox approvals**: the two
// toggles that skip a person, and YOLO, both. Approving and the toggles are an admin's.
// Issue #1001: each run card decides on its own — while its approval is pending, only it says so, and the others stay
// clickable; the box starts in the background. Vault also sets the auto-approve policy, per blast radius level.
// Issue #1018: a card's Approve goes through the Access requests approvals (store/access-approvals.ts), the same as
// Approve selected, so the card shows its own progress and result whichever started it.
// Issue #2197: one card per run. A job's ask that waits on a template, on its run, or on both, is one card: what the step
// will do and its undo, the access it needs (profiles, secrets, egress, image) and the job. Approve approves it all at
// once (`approve-run`), and the job's step goes on; Decline tells the job no. High-priority jobs' cards come first.
// Part 3: the approval is for this job only; Allow again, on the card, approves the access for later jobs too.
// Issue #2206: the job's asks for an AWS action on a role the template changes are on its card; Approve grants them too.
import { Boxes, Check, Loader2, Rocket, TriangleAlert, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ApprovalState, SelectBox } from '@/components/approval-state';
import { Confirm } from '@/components/confirm';
import { Empty, Panel } from '@/components/panel';
import { TemplateRadiusBadge, TemplateRadiusReasons } from '@/components/template-radius';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { post, RoleRefused, SessionRejected } from '@/lib/api';
import { HighTag } from '@/components/priority';
import { isHighJob } from '@/model/priority';
import {
  approvalText, autoApproveOf, egressText, explicitApprovals, highRadius, profileAskOf, profileText, rememberedKey, runCardKey, runCardsOf, sandboxApprovalsText, sandboxRunsDecided,
} from '@/model/vault';
import type { SandboxApprovals as Approvals, ProfileAsk, RememberedWriteView, RunCardView, SandboxRequestView, TemplateView, VaultSecret, VaultView } from '@/model/wire';
import { SandboxAsk } from './sandbox-ask';
import { useHopper } from '@/store';
import { approveItems, runItem, runKey, toggleSelected, useAccessApprovals } from '@/store/access-approvals';
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
  waiting: 'waits for a person', approved: 'approved: each step runs in a sandbox of its own', declined: 'declined',
};

/** Jev's sandbox-request check on a waiting request (issue #655 part 13): it checks it now, or held it for a person, with why. */
const jevText = (jev: NonNullable<RunCardView['jev']>): string =>
  jev.state === 'checking' ? 'Jev checks it now: it approves it, or leaves it to a person.' : `Jev held it for a person${jev.reason ? `: ${jev.reason}` : ''}.`;

/** What one approval of the card gives (issue #2197), in words for its confirm; `again`: allow again is on (part 3); the vault grant it carries (issue #2639). */
function grants(t: TemplateView | undefined, c: RunCardView, again: boolean): ReactNode {
  if (!t) return <>The job&apos;s steps run in sandboxes of <span className="font-mono">{c.template}</span>.</>;
  const changes = t.profiles.filter(highRadius), reads = t.profiles.filter((p) => !highRadius(p));
  return (
    <>
      Each step of this job runs in a new sandbox from <span className="font-mono">{t.image}</span>{t.tools?.length ? <> with <span className="font-mono">{t.tools.join(', ')}</span></> : null}{t.egress?.length ? <>, reaching <span className="font-mono">{t.egress.join(', ')}</span> through the egress proxy</> : null}, which the hopper destroys after the step.
      {' '}It may ask for <span className="font-mono">{t.secrets.join(', ') || 'no vault secret'}</span>{reads.length ? <>, read <span className="font-mono">{reads.map(profileText).join(', ')}</span></> : null}{changes.length ? <>, and change <span className="font-mono">{changes.map(profileText).join(', ')}</span> (high radius)</> : null}.
      {c.waits.template ? (again
        ? <> Allow again: a later job with the same needs runs with no new card, and each change approval is remembered.</>
        : <> For this job only: another job that asks for the same access gets a card of its own.</>) : null}
      {c.vaultGrant ? <> It also grants this job&apos;s item the vault: its steps get what the template gives, with no grant ask of their own.</> : null}
      {(c.actions ?? []).map((a) => <span key={`${a.role} ${a.action} ${a.resource}`}> It also grants {a.action} on {a.resource} as aws-role {a.role}: later steps of the same action are covered until the time limit of remembered write approvals.</span>)}
    </>
  );
}

/** One run card: also in the critical job tracker (issue #2203). */
export function Waiting({ c, template: t, asks, secrets, can, high }: { c: RunCardView; template?: TemplateView | undefined; asks?: ProfileAsk[] | undefined; secrets: readonly VaultSecret[]; can: boolean; high?: number | undefined }) {
  const [reason, setReason] = useState('');
  const [declining, setDeclining] = useState(false);
  const [again, setAgain] = useState(false);
  const key = runKey(c, t);
  const approval = useAccessApprovals((s) => s.items[key]);
  const selected = useAccessApprovals((s) => s.selected.includes(key));
  const pending = declining || approval?.state === 'pending';
  const decline = (): void => {
    setDeclining(true);
    void sendSandbox('/ui/api/sandbox-requests', { action: 'decline-run', job: c.jobId, template: c.template, reason: reason.trim() }, `${t?.label ?? c.template}: declined`, true).finally(() => setDeclining(false));
  };
  return (
    <li data-run-card={runCardKey(c)} {...(c.request ? { 'data-sandbox-request': c.request } : {})} className="space-y-2 rounded-md border border-warn/50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        {can && <SelectBox label={t?.label ?? c.template} checked={selected} disabled={pending} onChange={(on) => toggleSelected(key, on)} />}
        <Boxes className="size-4 text-warn" />
        {t?.label && <span data-slot="template-label" className="text-sm font-medium break-all">{t.label}</span>}
        <span className={t?.label ? 'font-mono text-xs text-muted-foreground break-all' : 'font-mono text-sm font-medium break-all'}>{c.template}</span>
        {t && <TemplateRadiusBadge radius={t.radius} />}
        {high !== undefined && <HighTag priority={high} />}
        <span className="text-xs text-warn">waits for a person{t && c.waits.template ? `: ${approvalText(t, c.jobId)}` : ''}</span>
      </div>
      <SandboxAsk purpose={c.purpose} plan={c.plan} job={{ id: c.jobId, title: c.jobTitle, url: c.jobUrl }} needs={t?.profiles} secrets={secrets} />
      {t && <TemplateRadiusReasons radius={t.radius} />}
      {t && explicitApprovals(t).map((p) => {
        const asked = profileAskOf(asks, t.name, p);
        return asked ? <p key={profileText(p)} data-slot="profile-asked" className="text-xs text-warn break-words">{profileText(p)}: {asked}</p> : null;
      })}
      {t && (
        <dl data-slot="run-access" className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Image</dt><dd className="font-mono break-all">{t.image}{t.tools?.length ? ` + ${t.tools.join(', ')}` : ''}</dd>
          <dt className="text-muted-foreground">Secrets</dt><dd className="font-mono break-words">{t.secrets.join(', ') || 'none'}</dd>
          <dt className="text-muted-foreground">Egress</dt><dd className="font-mono break-words">{egressText(t)}</dd>
          {c.vaultGrant && <><dt className="text-muted-foreground">Vault grant</dt><dd data-slot="run-vault-grant">granted to this job with the approval</dd></>}
        </dl>
      )}
      {c.actions?.length ? (
        <ul data-slot="run-actions" className="space-y-1 text-xs">{c.actions.map((a) => (
          <li key={`${a.role} ${a.action} ${a.resource}`} className="break-all">AWS action <span className="font-mono">{a.action}</span> on <span className="font-mono">{a.resource}</span> <span className="text-muted-foreground">as aws-role {a.role}</span></li>
        ))}</ul>
      ) : null}
      {c.jev && <p data-slot="sandbox-request-jev" className="text-xs text-warn">{jevText(c.jev)}</p>}
      <p className="text-xs text-muted-foreground">Asked at {c.askedAt}.</p>
      {can ? (
        <div className="flex flex-wrap items-center gap-2">
          <Confirm title={`Run ${t?.label ?? c.template} for this job?`} action="Approve" onConfirm={() => void approveItems([runItem(c, t, again)])} description={grants(t, c, again)}>
            <Button size="sm" disabled={pending}><Check />Approve</Button>
          </Confirm>
          {c.waits.template && (
            <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" title="Later jobs with the same needs run with no new card">
              <Switch checked={again} onCheckedChange={setAgain} disabled={pending} aria-label={`Allow again: ${c.template}`} />Allow again
            </label>
          )}
          <Input className="h-8 max-w-64 text-sm" placeholder="Why not (the job is told)" value={reason} onChange={(e) => setReason(e.target.value)} aria-label={`Why not run ${c.template}`} />
          <Button size="sm" variant="outline" disabled={pending || reason.trim() === ''} onClick={decline}><X />Decline</Button>
          {declining ? <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" />Declining…</span> : <ApprovalState approval={approval} />}
        </div>
      ) : <p className="text-xs text-muted-foreground">An admin approves it here.</p>}
    </li>
  );
}

/**
 * Access requests, Sandbox runs (issues #991, #2197): one card per job and template that waits for a person, its
 * template's approval and its run in one; high-priority jobs first. Always rendered: with none, it says what will show here.
 */
export function SandboxRuns({ view, can }: { view: VaultView | null; can: boolean }) {
  const jobs = useHopper((s) => s.jobs);
  const threshold = useHopper((s) => s.highPriority);
  const high = (id: string): boolean => isHighJob(jobs[id], threshold);
  const waiting = runCardsOf(view, high);
  const rest = sandboxRunsDecided(view);
  const templates = view?.templates ?? [];
  return (
    <div data-access-panel="sandbox-runs">
      <Panel title="Sandbox runs" icon={Rocket} count={waiting.length || ''} bodyClassName="space-y-3">
        <p className="text-sm text-muted-foreground">A job asks the hopper for a sandbox. Each card is one job&apos;s run, with what it will do and the access it needs: approve it once, and the job&apos;s steps run, each in a new sandbox the hopper destroys after the step. A run waits here for a person unless <a href="#vault" className="underline">the auto-approve policy</a> holds its blast radius, skip sandbox approval is on, or a person approved the same access for the job.</p>
        {waiting.length === 0 ? <Empty>No sandbox run waits. A run a job asks for waits here.</Empty>
          : <ul className="space-y-2">{waiting.map((c) => <Waiting key={runCardKey(c)} c={c} template={templates.find((t) => t.name === c.template)} asks={view?.asks} secrets={view?.secrets ?? []} can={can} high={high(c.jobId) ? jobs[c.jobId]?.priority : undefined} />)}</ul>}
        {rest.length > 0 && (
          <ul className="space-y-1 text-xs">
            {rest.map((r) => (
              <li key={r.id} data-sandbox-request={r.id} className="break-words">
                <span className="font-mono">{r.template}</span> for job <a href={`#jobs/${r.jobId}`} className="font-mono underline">{r.jobId.slice(0, 8)}</a>: {STATE_TEXT[r.state]}
                {r.approvedBy ? <>, approved by {r.approvedBy}</> : null}{r.reason ? <> — {r.reason}</> : null}
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

/** Vault, Sandbox approvals (issue #991): skip template approval, skip sandbox approval, and YOLO, both; the standing read grant (issue #1472); the auto-approve policy and the remembered write approvals (issue #1001). */
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
        <p className="text-sm text-muted-foreground">Jobs start their own sandboxes: a job asks, the hopper makes or reuses the template, and runs each step in a sandbox of its own. {sandboxApprovalsText(approvals)}</p>
        {yolo && (
          <p role="note" className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
            <TriangleAlert className="size-4 shrink-0 text-amber-600" />Nobody approves anything: a job can get write, sync or apply on any asset it names. Each approval is still an event that names the toggle.
          </p>
        )}
        {row('YOLO', 'Both below: a job gets its sandbox with no person.', yolo, (on) => set({ yolo: on }, on ? 'YOLO is on' : 'YOLO is off'))}
        {row('Skip template approval', 'A new template a job asks for is approved at once, its write, sync and apply profiles too.', a.skipTemplateApproval, (on) => set({ skipTemplateApproval: on }, 'Saved'))}
        {row('Skip sandbox approval', 'A sandbox run starts the moment a job asks, a high-blast-radius one too.', a.skipSandboxApproval, (on) => set({ skipSandboxApproval: on }, 'Saved'))}
        {row('Standing read grant', 'A job on a sandbox whose template only reads what the read policy holds gets the vault with no person. A template with a write or a vault secret still waits for a person\'s grant. Off: no job that has not asked yet gets it.', a.standingReadGrant === true, (on) => set({ standingReadGrant: on }, on ? 'Standing read grant is on' : 'Standing read grant is off'))}
        <p className="pt-1 font-medium">Auto-approve by blast radius</p>
        <p className="text-xs text-muted-foreground">A new template a job asks for, and a sandbox run, of a level on here is approved with no person. Each approval is an event that names the auto-approve policy.</p>
        {LEVELS.map((l) => row(`Auto-approve ${l} radius`, LEVEL_HINT[l], auto[l], (on) => set({ autoApprove: { [l]: on } }, 'Saved')))}
        <Remembered remembered={remembered} hours={a.rememberWritesHours ?? 168} can={can} busy={busy} />
        {!can && <p className="text-xs text-muted-foreground">An admin changes these.</p>}
      </Panel>
    </div>
  );
}
