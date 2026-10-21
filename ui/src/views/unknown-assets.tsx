// Unknown assets on Access requests (issue #2123): each template with a need on a cluster the vault cannot find (issue
// #2067) — the ones its nav badge counts — with the reason, and what fixes it: a cluster override for the name, an edit
// of the template's needs on Vault, or Remove. No approval makes such a template work, so it has no Approve.
// Issue #2168: one click points the template at a cluster: each candidate of an ambiguous short name here, and on a
// template card the one cluster a short name resolves to (ShortClusters).
import { Crosshair, Trash2, TriangleAlert } from 'lucide-react';
import { Confirm } from '@/components/confirm';
import { Empty, Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { pointedAt, unknownReason } from '@/model/vault';
import type { TemplateView } from '@/model/wire';
import { sendVault, useVaultStore } from '@/store/vault';

/** One click that saves the template with each need on cluster `from` naming `to` (issue #2168): an admin's. */
function PointAt({ t, from, to }: { t: TemplateView; from: string; to: string }) {
  const busy = useVaultStore((s) => s.busy);
  return (
    <Confirm title={`Point ${t.label ?? t.name} at ${to}?`} action="Point at it" onConfirm={() => void sendVault(pointedAt(t, from, to), `${t.name}: points at ${to}`)}
      description={`Each need of the template on cluster ${from} names ${to} in its place. A need it changes waits for approval again, as any edit of its needs does.`}>
      <Button size="sm" variant="outline" data-point-at={to} disabled={busy}><Crosshair />Point at {to}</Button>
    </Confirm>
  );
}

/** A template's short cluster names (issue #2168), each with the cluster it resolves to and one click to name it in full. */
export function ShortClusters({ t, can }: { t: TemplateView; can: boolean }) {
  if (!t.shortClusters?.length) return null;
  return (
    <ul data-short-clusters={t.name} className="space-y-1 text-xs">
      {t.shortClusters.map((s) => (
        <li key={s.cluster} className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">cluster {s.cluster} resolves to {s.to}</span>
          {can && <PointAt t={t} from={s.cluster} to={s.to} />}
        </li>
      ))}
    </ul>
  );
}

function Row({ t, can }: { t: TemplateView; can: boolean }) {
  const busy = useVaultStore((s) => s.busy);
  return (
    <li data-unknown-asset={t.name} className="space-y-2 rounded-md border p-3">
      <div className="font-mono text-sm font-medium break-all">{t.label ?? t.name}</div>
      <p className="text-xs text-warn break-words">unknown asset: {unknownReason(t)}</p>
      {can && (t.unknownAssets ?? []).some((u) => u.candidates) && (
        <div className="flex flex-wrap items-center gap-2">
          {(t.unknownAssets ?? []).flatMap((u) => (u.candidates ?? []).map((c) => <PointAt key={`${u.cluster}/${c}`} t={t} from={u.cluster} to={c} />))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <a href="#settings/clusters" className="underline">Add a cluster override</a>
        <a href="#vault" className="underline">Edit its needs on Vault</a>
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
        <p className="text-sm text-muted-foreground">A template names a cluster that no AWS source of the topology lists, with no minting credential or cluster override of its own, or a short name that starts several of them. The vault cannot find it, so the template never passes its read-only check. Point it at a cluster, add a cluster override that names the cluster, or remove it. These wait for no approval, so the Access requests badge does not count them.</p>
        {templates.length === 0 ? <Empty>No template names a cluster the vault cannot find.</Empty>
          : <ul className="space-y-2">{templates.map((t) => <Row key={t.name} t={t} can={can} />)}</ul>}
      </Panel>
    </div>
  );
}
