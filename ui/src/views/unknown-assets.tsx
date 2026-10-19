// Unknown assets on Access requests (issue #2123): each template with a need on a cluster the vault cannot find (issue
// #2067) — the ones its nav badge counts — with the reason, and what fixes it: a cluster override for the name, an edit
// of the template's needs on Settings → Vault, or Remove. No approval makes such a template work, so it has no Approve.
import { Trash2, TriangleAlert } from 'lucide-react';
import { Confirm } from '@/components/confirm';
import { Empty, Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { unknownReason } from '@/model/vault';
import type { TemplateView } from '@/model/wire';
import { sendVault, useVaultStore } from '@/store/vault';

function Row({ t, can }: { t: TemplateView; can: boolean }) {
  const busy = useVaultStore((s) => s.busy);
  return (
    <li data-unknown-asset={t.name} className="space-y-2 rounded-md border p-3">
      <div className="font-mono text-sm font-medium break-all">{t.label ?? t.name}</div>
      <p className="text-xs text-warn break-words">unknown asset: {unknownReason(t)}</p>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <a href="#settings/clusters" className="underline">Add a cluster override</a>
        <a href="#settings/vault" className="underline">Edit its needs on Settings → Vault</a>
        {can && (
          <Confirm title={`Remove ${t.name}?`} action="Remove" onConfirm={() => void sendVault({ action: 'remove-template', name: t.name }, `${t.name}: removed`)}
            description="The template is deleted. A job that asks for it again makes a new one.">
            <Button size="sm" variant="outline" disabled={busy}><Trash2 />Remove</Button>
          </Confirm>
        )}
      </div>
    </li>
  );
}

export function UnknownAssets({ templates, can }: { templates: TemplateView[]; can: boolean }) {
  return (
    <div data-access-panel="unknown-assets">
      <Panel title="Unknown assets" icon={TriangleAlert} count={templates.length || ''} bodyClassName="space-y-3">
        <p className="text-sm text-muted-foreground">A template names a cluster that no AWS source of the topology lists, with no minting credential or cluster override of its own. The vault cannot find it, so the template never passes its read-only check. Add a cluster override that names the cluster, change the template to a known cluster, or remove it.</p>
        {templates.length === 0 ? <Empty>No template names a cluster the vault cannot find.</Empty>
          : <ul className="space-y-2">{templates.map((t) => <Row key={t.name} t={t} can={can} />)}</ul>}
      </Panel>
    </div>
  );
}
