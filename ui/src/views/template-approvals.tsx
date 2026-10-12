// Access requests, Template approvals (issue #897; the approvals of issues #558 and #584, moved from Settings → Vault): each
// template that waits for a person — never approved, or a new image, secret or profile since — with what waits and its
// blast radius. Approve approves it as it is, its read profiles with it; a write, sync or apply profile takes its own
// explicit approval. A machine's box of a waiting template takes no job until then. Editing a template stays on Settings →
// Vault. With none, the panel says what will show here. Approving is an admin's.
import { Boxes, Check, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Confirm } from '@/components/confirm';
import { Empty, Panel } from '@/components/panel';
import { TemplateRadiusBadge, TemplateRadiusReasons } from '@/components/template-radius';
import { approvalText, explicitApprovals, highRadius, profileAskOf, profileText, templateWaits } from '@/model/vault';
import type { ProfileAsk, TemplateView } from '@/model/wire';
import type { Send } from './vault';

function Waiting({ t, asks, can, busy, send }: { t: TemplateView; asks?: ProfileAsk[]; can: boolean; busy: boolean; send: Send }) {
  const reads = t.pending.profiles.filter((p) => !highRadius(p));
  const whole = !t.approval || t.pending.image || t.pending.secrets.length > 0 || reads.length > 0;
  return (
    <li data-template-approval={t.name} className="space-y-2 rounded-md border border-warn/50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Boxes className="size-4 text-warn" />
        <span className="font-mono text-sm font-medium break-all">{t.name}</span>
        <TemplateRadiusBadge radius={t.radius} />
        <span className="text-xs text-warn">{approvalText(t)}</span>
      </div>
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
        <div className="flex flex-wrap gap-2">
          {whole && (
            <Confirm title={`Approve ${t.name}?`} action="Approve" onConfirm={() => void send({ action: 'approve-template', name: t.name }, `${t.name}: approved`)}
              description={<>Boxes from <span className="font-mono">{t.image}</span>{t.tools?.length ? <> with <span className="font-mono">{t.tools.join(', ')}</span></> : null} may then ask for <span className="font-mono">{t.secrets.join(', ') || 'nothing'}</span>, whatever job runs in them{reads.length ? <>, and read <span className="font-mono">{reads.map(profileText).join(', ')}</span></> : null}. A write, sync or apply profile is not approved by this.</>}>
              <Button size="sm" disabled={busy}><Check />Approve</Button>
            </Confirm>
          )}
          {explicitApprovals(t).map((p) => (
            <Confirm key={profileText(p)} title={`Approve ${t.name}: ${profileText(p)}?`} action="Approve" onConfirm={() => void send({ action: 'approve-profile', name: t.name, ...p }, `${t.name}: ${profileText(p)} approved`)}
              description={<>This is a high-radius profile: it changes <span className="font-mono">{p.asset.kind} {p.asset.name}</span>. Every job in a box of <span className="font-mono">{t.name}</span> may then {p.operation} there. An approval for read does not cover this.</>}>
              <Button size="sm" variant="outline" disabled={busy}><ShieldAlert />Approve {profileText(p)}</Button>
            </Confirm>
          ))}
          <a href="#settings/vault" className="inline-flex h-8 items-center text-sm text-muted-foreground hover:underline">Edit on Settings → Vault</a>
        </div>
      ) : <p className="text-xs text-muted-foreground">An admin approves it here.</p>}
    </li>
  );
}

export function TemplateApprovals({ templates, asks, can, busy, send }: { templates: TemplateView[]; asks?: ProfileAsk[]; can: boolean; busy: boolean; send: Send }) {
  const waiting = templates.filter(templateWaits);
  return (
    <div data-access-panel="templates">
      <Panel title="Template approvals" icon={Boxes} count={waiting.length || ''} bodyClassName="space-y-3">
        <p className="text-sm text-muted-foreground">A box of a template takes no job and gets nothing from the vault until a person approves the template, and again after a new image, secret or profile. A write, sync or apply profile takes its own approval.</p>
        {waiting.length === 0 ? <Empty>No template waits for approval. A template a person or a job adds, or changes, waits here.</Empty>
          : <ul className="space-y-2">{waiting.map((t) => <Waiting key={t.name} t={t} asks={asks} can={can} busy={busy} send={send} />)}</ul>}
      </Panel>
    </div>
  );
}
