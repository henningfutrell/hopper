// Access requests, Template approvals (issue #897; the approvals of issues #558 and #584, moved from Settings → Vault): each
// template that waits for a person — never approved, or a new image, secret or profile since — with what waits and its
// blast radius. Approve approves it as it is, its read profiles with it; a write, sync or apply profile takes its own
// explicit approval. A machine's box of a waiting template takes no job until then. Editing a template stays on Settings →
// Vault. With none, the panel says what will show here. Approving is an admin's.
// Issue #1001: a card with a write, sync or apply profile shows one **Approve all listed**: the template and each listed
// profile, in one confirm, sent side by side (issue #1018). Each card's approval is its own: while it is pending, only
// that card says so, and then its result; a card can be selected for Approve selected (access-requests.tsx). Each card says
// what the template is for: its readable name first, why the job asked, the job and its link, the plan, and each need in
// plain words (sandbox-ask.tsx).
import { Boxes, Check, ShieldAlert } from 'lucide-react';
import { ApprovalState, SelectBox } from '@/components/approval-state';
import { Button } from '@/components/ui/button';
import { Confirm } from '@/components/confirm';
import { Empty, Panel } from '@/components/panel';
import { TemplateRadiusBadge, TemplateRadiusReasons } from '@/components/template-radius';
import { approvalText, explicitApprovals, highRadius, profileAskOf, profileText, templateWaits } from '@/model/vault';
import type { ProfileAsk, TemplateView, VaultSecret } from '@/model/wire';
import { approveItems, templateItem, templateKey, toggleSelected, useAccessApprovals } from '@/store/access-approvals';
import { SandboxAsk } from './sandbox-ask';

function Waiting({ t, asks, secrets, can }: { t: TemplateView; asks?: ProfileAsk[]; secrets: readonly VaultSecret[]; can: boolean }) {
  const approval = useAccessApprovals((s) => s.items[templateKey(t)]);
  const selected = useAccessApprovals((s) => s.selected.includes(templateKey(t)));
  const pending = approval?.state === 'pending';
  const reads = t.pending.profiles.filter((p) => !highRadius(p));
  const explicit = explicitApprovals(t);
  const approve = (): void => { void approveItems([templateItem(t)]); };
  return (
    <li data-template-approval={t.name} className="space-y-2 rounded-md border border-warn/50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        {can && <SelectBox label={t.label ?? t.name} checked={selected} disabled={pending} onChange={(on) => toggleSelected(templateKey(t), on)} />}
        <Boxes className="size-4 text-warn" />
        {t.label ? (
          <>
            <span data-slot="template-label" className="text-sm font-medium break-all">{t.label}</span>
            <span className="font-mono text-xs text-muted-foreground break-all">{t.name}</span>
          </>
        ) : <span className="font-mono text-sm font-medium break-all">{t.name}</span>}
        <TemplateRadiusBadge radius={t.radius} />
        <span className="text-xs text-warn">{approvalText(t)}</span>
      </div>
      <SandboxAsk purpose={t.purpose} plan={t.plan} job={t.askedByJob} needs={t.profiles} secrets={secrets} />
      <TemplateRadiusReasons radius={t.radius} />
      {explicitApprovals(t).map((p) => {
        const asked = profileAskOf(asks, t.name, p);
        return asked ? <p key={profileText(p)} data-slot="profile-asked" className="text-xs text-warn break-words">{profileText(p)}: {asked}</p> : null;
      })}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Image</dt><dd className="font-mono break-all">{t.image}</dd>
        <dt className="text-muted-foreground">Scope</dt><dd className="font-mono break-words">{t.secrets.join(', ') || 'none'}</dd>
      </dl>
      {can ? (
        <div className="flex flex-wrap items-center gap-2">
          {explicit.length > 0 ? (
            <Confirm title={`Approve all listed for ${t.name}?`} action="Approve all listed" onConfirm={approve}
              description={<>Boxes from <span className="font-mono">{t.image}</span>{t.tools?.length ? <> with <span className="font-mono">{t.tools.join(', ')}</span></> : null} may then ask for <span className="font-mono">{t.secrets.join(', ') || 'nothing'}</span>{reads.length ? <>, read <span className="font-mono">{reads.map(profileText).join(', ')}</span></> : null}, and <span className="font-mono">{explicit.map(profileText).join(', ')}</span>: high radius, it changes those assets. Every job in a box of <span className="font-mono">{t.name}</span> may then do so. A job that asked for this template gets its sandbox run with this approval.</>}>
              <Button size="sm" disabled={pending}><ShieldAlert />Approve all listed</Button>
            </Confirm>
          ) : (
            <Confirm title={`Approve ${t.name}?`} action="Approve" onConfirm={approve}
              description={<>Boxes from <span className="font-mono">{t.image}</span>{t.tools?.length ? <> with <span className="font-mono">{t.tools.join(', ')}</span></> : null} may then ask for <span className="font-mono">{t.secrets.join(', ') || 'nothing'}</span>, whatever job runs in them{reads.length ? <>, and read <span className="font-mono">{reads.map(profileText).join(', ')}</span></> : null}. A job that asked for this template gets its sandbox run with this approval.</>}>
              <Button size="sm" disabled={pending}><Check />Approve</Button>
            </Confirm>
          )}
          <ApprovalState approval={approval} />
          <a href="#settings/vault" className="inline-flex h-8 items-center text-sm text-muted-foreground hover:underline">Edit on Settings → Vault</a>
        </div>
      ) : <p className="text-xs text-muted-foreground">An admin approves it here.</p>}
    </li>
  );
}

export function TemplateApprovals({ templates, asks, secrets, can }: { templates: TemplateView[]; asks?: ProfileAsk[]; secrets: readonly VaultSecret[]; can: boolean }) {
  const waiting = templates.filter(templateWaits);
  return (
    <div data-access-panel="templates">
      <Panel title="Template approvals" icon={Boxes} count={waiting.length || ''} bodyClassName="space-y-3">
        <p className="text-sm text-muted-foreground">A box of a template takes no job and gets nothing from the vault until a person approves the template, and again after a new image, secret or profile. A write, sync or apply profile is listed on the card: Approve all listed approves it with the template.</p>
        {waiting.length === 0 ? <Empty>No template waits for approval. A template a person or a job adds, or changes, waits here.</Empty>
          : <ul className="space-y-2">{waiting.map((t) => <Waiting key={t.name} t={t} asks={asks} secrets={secrets} can={can} />)}</ul>}
      </Panel>
    </div>
  );
}
