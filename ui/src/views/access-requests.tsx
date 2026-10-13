// Access requests (issue #897): the one home of what jobs on boxes wait on a person for — the credentials they asked for
// (Asked for, issue #583), the vault grants they wait for (issue #652), the templates that wait for approval (issues
// #558, #584), and the sandbox runs jobs asked for (issue #991). Always rendered: each panel says what will show there when nothing waits. Settings → Vault keeps the
// configuration. Its nav badge, and its row in Needs you, count what waits (accessRequestsWaiting).
import { Ticket } from 'lucide-react';
import { Panel } from '@/components/panel';
import { useCanAdmin } from '@/store/selectors';
import { sendDecision, sendVault, useVault, useVaultStore } from '@/store/vault';
import { AskedFor } from './vault-requests';
import { VaultGrants } from './vault-grants';
import { TemplateApprovals } from './template-approvals';
import { SandboxRuns } from './sandbox-approvals';

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
      {/* Issue #1001: each template and run card decides on its own; one pending blocks no other. */}
      <TemplateApprovals templates={view?.templates ?? []} {...(view?.asks ? { asks: view.asks } : {})} secrets={view?.secrets ?? []} can={can} send={sendDecision} />
      <SandboxRuns view={view} can={can} />
      <Panel title="Box tokens" icon={Ticket}>
        <p className="text-sm text-muted-foreground">An agent that approves or merges work, or starts a job, through the API needs a box token: a token of a grant minted with Box grant on. Mint one, or end one, on <a href="#settings/api-tokens" className="underline">Settings → API tokens</a>.</p>
      </Panel>
    </div>
  );
}
