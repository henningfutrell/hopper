// Access requests (issue #897): the one home of what jobs on boxes wait on a person for — the credentials they asked for
// (Asked for, issue #583), the vault grants they wait for (issue #652), the templates that wait for approval (issues
// #558, #584), and the sandbox runs jobs asked for (issue #991). Always rendered: each panel says what will show there when nothing waits. Vault keeps the
// configuration. Its nav badge, and its row in Needs you, count what waits for approval (accessRequestsWaiting) and nothing
// else (issue #2168). The templates with an unknown asset (unknownAssetTemplates) show here too (issue #2123), counted in
// Needs you's Unknown clusters row, never as an approval.
// Issue #1018: an admin selects template and sandbox run cards, or all that wait, and one Approve selected approves
// them all, side by side; each card shows its own progress and result, and the bar counts what was approved and failed.
// Issue #1138: an admin mints a delegate approver here, an agent that approves what waits for them, and revokes it here.
// Issue #2197: one card per sandbox run, first: a template a job asked for is approved on its run card, not on its own.
// Issue #2146: the bastions of jobs that run now, each with Stop (an operator's).
import { CheckCheck, Ticket } from 'lucide-react';
import { useEffect } from 'react';
import { Confirm } from '@/components/confirm';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { isHighJob } from '@/model/priority';
import { ownTemplatesWaiting, runCardsOf, unknownAssetTemplates } from '@/model/vault';
import type { VaultView } from '@/model/wire';
import { approveItems, batchText, forgetEndedItems, runItem, selectOnly, templateItem, useAccessApprovals } from '@/store/access-approvals';
import { useHopper } from '@/store';
import { useCanAdmin, useCanOperate } from '@/store/selectors';
import { sendVault, useVault, useVaultStore } from '@/store/vault';
import { AskedFor } from './vault-requests';
import { VaultGrants } from './vault-grants';
import { ActionGrants } from './action-grants';
import { Bastions } from './bastions';
import { TemplateApprovals } from './template-approvals';
import { SandboxRuns } from './sandbox-approvals';
import { UnknownAssets } from './unknown-assets';
import { DelegateApprovers } from './delegate-approvers';

/** The run cards and a person's own template cards that wait: each one Approve selected can approve. */
const waitingItems = (view: VaultView | null, high: (jobId: string) => boolean) => [
  ...runCardsOf(view, high).map((c) => runItem(c, view?.templates.find((t) => t.name === c.template))), ...ownTemplatesWaiting(view).map(templateItem),
];

function ApproveSelected({ view }: { view: VaultView | null }) {
  const jobs = useHopper((s) => s.jobs);
  const threshold = useHopper((s) => s.highPriority);
  const all = waitingItems(view, (id) => isHighJob(jobs[id], threshold));
  const chosen = useAccessApprovals((s) => s.selected);
  const last = useAccessApprovals((s) => s.last);
  const picked = all.filter((i) => chosen.includes(i.key));
  return (
    <div data-slot="approve-selected" className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm">
      <Button size="sm" variant="outline" disabled={all.length === 0} onClick={() => selectOnly(all.map((i) => i.key))}>Select all waiting</Button>
      {picked.length > 0 && <Button size="sm" variant="ghost" onClick={() => selectOnly([])}>Clear</Button>}
      <Confirm title={`Approve ${picked.length} selected?`} action="Approve selected" onConfirm={() => void approveItems(picked)}
        description={<>Each selected run is approved with the access its card lists, and its job&apos;s steps run. Each selected template is approved as it is, with each write, sync or apply profile its card lists. Each approval goes at once, on its own: one that fails stops no other.</>}>
        <Button size="sm" disabled={picked.length === 0}><CheckCheck />{picked.length ? `Approve selected (${picked.length})` : 'Approve selected'}</Button>
      </Confirm>
      {last && <span className={last.failed ? 'text-xs text-bad' : 'text-xs text-ok'}>{batchText(last)}</span>}
    </div>
  );
}

export function AccessRequests() {
  const can = useCanAdmin();
  const canOperate = useCanOperate();
  const view = useVault();
  const busy = useVaultStore((s) => s.busy);
  const error = useVaultStore((s) => s.error);
  useEffect(() => forgetEndedItems, []);
  return (
    <div className="max-w-2xl space-y-3">
      <p className="text-sm text-muted-foreground">What jobs on boxes wait for a person to decide. <a href="/help/needs-you#access-requests" className="underline">Help</a></p>
      {!view && error && <p role="alert" className="text-sm text-bad break-words">Could not read the vault: {error}</p>}
      <AskedFor requests={view?.requests ?? []} can={can} busy={busy} send={sendVault} />
      <VaultGrants view={view} />
      {/* Issue #2206: an AWS action a job's step needs that the role's own access does not give. */}
      <ActionGrants view={view} can={can} />
      {/* Issue #1001: each template and run card decides on its own; one pending blocks no other. Issue #1018: or several at once. */}
      {can && <ApproveSelected view={view} />}
      {/* Issue #2197: one card per run, its template's approval with it; a template card only for a person's own template. */}
      <SandboxRuns view={view} can={can} />
      <TemplateApprovals waiting={ownTemplatesWaiting(view)} {...(view?.asks ? { asks: view.asks } : {})} secrets={view?.secrets ?? []} can={can} />
      <UnknownAssets templates={unknownAssetTemplates(view)} can={can} />
      {/* Issue #2146: the bastions of jobs that run now; an operator stops one. */}
      <Bastions view={view} can={canOperate} />
      {can && <DelegateApprovers />}
      <Panel title="Box tokens" icon={Ticket}>
        <p className="text-sm text-muted-foreground">An agent that approves or merges work, or starts a job, through the API needs a box token: a token of a grant minted with Box grant on. Mint one, or end one, on <a href="#users-access/api-tokens" className="underline">Users & access → API tokens</a>.</p>
      </Panel>
    </div>
  );
}
