// Access requests (issue #897): the one home of what jobs on boxes wait on a person for — the credentials they asked for
// (Asked for, issue #583), the vault grants they wait for (issue #652), and the templates that wait for approval (issues
// #558, #584). Always rendered: each panel says what will show there when nothing waits. Settings → Vault keeps the
// configuration. Its nav badge, and its row in Needs you, count what waits (accessRequestsWaiting).
import { Ticket } from 'lucide-react';
import { Panel } from '@/components/panel';
import { useCanAdmin } from '@/store/selectors';
import { sendVault, useVault, useVaultStore } from '@/store/vault';
import { AskedFor } from './vault-requests';
import { VaultGrants } from './vault-grants';
import { TemplateApprovals } from './template-approvals';

export function AccessRequests() {
  const can = useCanAdmin();
  const view = useVault();
  const busy = useVaultStore((s) => s.busy);
  const error = useVaultStore((s) => s.error);
  return (
    <div className="max-w-2xl space-y-3">
      <p className="text-sm text-muted-foreground">What jobs on boxes wait for a person to decide. <a href="/help/needs-you#access-requests" className="underline">Help</a></p>
      {!view && error && <p role="alert" className="text-sm text-bad break-words">Could not read the vault: {error}</p>}
      <AskedFor requests={view?.requests ?? []} can={can} busy={busy} send={sendVault} />
      <VaultGrants view={view} />
      <TemplateApprovals templates={view?.templates ?? []} {...(view?.asks ? { asks: view.asks } : {})} can={can} busy={busy} send={sendVault} />
      <Panel title="Box tokens" icon={Ticket}>
        <p className="text-sm text-muted-foreground">An agent that approves or merges work, or starts a job, through the API needs a box token: a token of a grant minted with Box grant on. Mint one, or end one, on <a href="#settings/api-tokens" className="underline">Settings → API tokens</a>.</p>
      </Panel>
    </div>
  );
}
