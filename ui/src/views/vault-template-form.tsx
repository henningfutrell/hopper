// A template's form on Vault (issues #558, #584, #716, #708): its name (fixed once saved), its image, the
// vault secrets, the tools and the operation profiles its boxes may ask for, its egress hosts and bastion targets (#2146), and the limits a launch of it may ask for
// (sandbox-limits.tsx). A change of image, secrets, tools or profiles waits for approval; limits do not, they give a
// box nothing.
import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FIELD } from '@/components/plugin-form';
import { Label } from '@/components/vault-fields';
import { highRadius, profileText, DEFAULT_BOX_IMAGE, EGRESS_HOST, egressOf, BASTION_TARGET, bastionTargetsOf } from '@/model/vault';
import { limitsDraft, templateLimits } from '@/model/sandbox-launch';
import type { AssetKind, Operation, OperationProfile, SharedSecretView, TemplateView, VaultSecret } from '@/model/wire';
import { LimitsInput } from './sandbox-limits';
import { ToolsInput } from './vault-tools';
import { AgentCredentialInput } from './vault-agent-credential';
import { agentCredentialOf } from '@/model/vault-agent-credential';
import { BackendsInput } from './vault-state-backend';
import { ProbeMarksInput } from './vault-probe-marks';
import type { Send } from './vault';

const OPERATIONS: Operation[] = ['read', 'write', 'sync', 'apply', 'observe'];
const ASSET_KINDS: AssetKind[] = ['cluster', 'namespace', 'argocd-app', 'terraform-workspace', 'aws-account', 'aws-role', 'database'];
export const sameProfile = (a: OperationProfile, b: OperationProfile) => profileText(a) === profileText(b);

/** The operation profiles a template's boxes may ask for: each removable, and one more added from an operation, an asset kind and a name. */
function ProfilesInput({ profiles, busy, onChange }: { profiles: OperationProfile[]; busy: boolean; onChange: (p: OperationProfile[]) => void }) {
  const [operation, setOperation] = useState<Operation>('read');
  const [kind, setKind] = useState<AssetKind>('cluster');
  const [asset, setAsset] = useState('');
  const add = () => {
    const p = { operation, asset: { kind, name: asset.trim() } };
    if (!profiles.some((x) => sameProfile(x, p))) onChange([...profiles, p]);
    setAsset('');
  };
  return (
    <div className="space-y-1"><Label>Operation profiles its boxes may ask for — write, sync and apply each need their own approval</Label>
      {profiles.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Operation profiles">
          {profiles.map((p) => (
            <li key={profileText(p)} className={`flex min-h-8 items-center gap-1 rounded-md border px-2 font-mono text-xs ${highRadius(p) ? 'border-warn' : ''}`}>
              {profileText(p)}
              <button type="button" aria-label={`Remove ${profileText(p)}`} disabled={busy} onClick={() => onChange(profiles.filter((x) => !sameProfile(x, p)))}><X className="size-3" /></button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <select aria-label="Operation" className={`${FIELD} w-24`} value={operation} disabled={busy} onChange={(e) => setOperation(e.target.value as Operation)}>
          {OPERATIONS.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <select aria-label="Asset kind" className={`${FIELD} w-44`} value={kind} disabled={busy} onChange={(e) => setKind(e.target.value as AssetKind)}>
          {ASSET_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <Input aria-label="Asset" className="h-8 w-40 font-mono text-xs" value={asset} placeholder="lab" maxLength={200} disabled={busy} autoCapitalize="off" autoCorrect="off" spellCheck={false}
          onChange={(e) => setAsset(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (asset.trim()) add(); } }} />
        <Button type="button" size="sm" variant="outline" disabled={busy || !asset.trim()} onClick={add}><Plus />Add profile</Button>
      </div>
    </div>
  );
}

/** A template's form: its name (fixed once saved), its image, the vault secrets, tools and operation profiles its boxes may ask for, its limits. */
export function TemplateForm({ t, secrets: all, shared = [], busy, send, onDone }: { t?: TemplateView; secrets: VaultSecret[]; shared?: SharedSecretView[]; busy: boolean; send: Send; onDone: () => void }) {
  // A minting credential is never given to a box: no template's scope lists it. A shared secret may be (issue #718).
  const secrets = [...all.filter((s) => !s.mints).map((s) => ({ key: s.id, name: s.name })), ...shared.map((s) => ({ key: s.name, name: s.name }))];
  const [name, setName] = useState(t?.name ?? '');
  const [image, setImage] = useState(t?.image ?? DEFAULT_BOX_IMAGE);
  const [scope, setScope] = useState<string[]>(t?.secrets ?? []);
  const [profiles, setProfiles] = useState<OperationProfile[]>(t?.profiles ?? []);
  const [tools, setTools] = useState<string[]>(t?.tools ?? []);
  const [egress, setEgress] = useState((t?.egress ?? []).join(' '));
  const [targets, setTargets] = useState((t?.bastionTargets ?? []).join(' '));
  const [limits, setLimits] = useState(limitsDraft(t?.limits));
  const [credential, setCredential] = useState(t?.agentCredential ?? '');
  const [marks, setMarks] = useState<Record<string, string>>(t?.probeMarks ?? {});
  const saved = templateLimits(limits);
  const hosts = egressOf(egress), badHost = hosts.find((h) => !EGRESS_HOST.test(h));
  const forwards = bastionTargetsOf(targets), badTarget = forwards.find((x) => !BASTION_TARGET.test(x));
  const toggle = (n: string) => setScope(scope.includes(n) ? scope.filter((x) => x !== n) : [...scope, n]);
  return (
    <form className="space-y-3" onSubmit={async (e) => {
      e.preventDefault();
      if (!saved.ok || badHost || badTarget) return;
      if (await send({ action: 'save-template', name: name.trim(), image: image.trim(), secrets: scope, profiles, tools, egress: hosts, bastionTargets: forwards, limits: saved.limits, agentCredential: agentCredentialOf(credential, scope), ...(t?.readOnly ? { probeMarks: marks } : {}) }, `${name.trim()}: saved`)) onDone();
    }}>
      {!t && (
        <label className="block space-y-1"><Label>Name — its boxes are named hopper-sandbox-&lt;name&gt;</Label>
          <Input className="h-9 font-mono text-sm" value={name} required maxLength={64} pattern="[a-z0-9][a-z0-9._\-]*" autoCapitalize="off" autoCorrect="off" spellCheck={false}
            placeholder="kube" onChange={(e) => setName(e.target.value)} /></label>
      )}
      <label className="block space-y-1"><Label>Image — what its boxes run</Label>
        <Input className="h-9 font-mono text-sm" value={image} required maxLength={300} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => setImage(e.target.value)} /></label>
      <div className="space-y-1"><Label>Secrets its boxes may ask for</Label>
        {secrets.length === 0 ? <div className="text-xs text-muted-foreground">Add a secret above first.</div> : (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Secrets">
            {secrets.map((s) => {
              const on = scope.includes(s.name);
              return <button key={s.key} type="button" aria-pressed={on} disabled={busy} onClick={() => toggle(s.name)}
                className={`min-h-8 rounded-md border px-2 font-mono text-xs transition-colors ${on ? 'border-primary bg-primary text-primary-foreground' : 'border-input text-muted-foreground hover:bg-muted'}`}>{s.name}</button>;
            })}
          </div>
        )}
      </div>
      <AgentCredentialInput choice={credential} scope={scope} busy={busy} onChange={setCredential} />
      <ToolsInput tools={tools} busy={busy} onChange={setTools} />
      <label className="block space-y-1"><Label>Egress hosts — host:port its boxes may reach through the egress proxy, beside AWS and the minted clusters</Label>
        <Input className="h-9 font-mono text-sm" value={egress} maxLength={2000} autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={busy}
          placeholder="auth.example.com:443" aria-invalid={badHost !== undefined} onChange={(e) => setEgress(e.target.value)} />
        {badHost && <span className="block text-xs text-destructive">{badHost} is not host:port: a DNS name or an address, no scheme, no wildcard.</span>}
      </label>
      <label className="block space-y-1"><Label>Bastion targets — what a bastion of it may forward to, each on a cluster or namespace it has an observe on</Label>
        <Input aria-label="Bastion targets" className="h-9 font-mono text-sm" value={targets} maxLength={8000} autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={busy}
          placeholder="utility/monitoring/svc/prometheus-server:9090" aria-invalid={badTarget !== undefined} onChange={(e) => setTargets(e.target.value)} />
        {badTarget && <span className="block text-xs text-destructive">{badTarget} is not &lt;cluster&gt;/&lt;namespace&gt;/&lt;svc|pod|deploy&gt;/&lt;name&gt;:&lt;port&gt;.</span>}
      </label>
      <ProfilesInput profiles={profiles} busy={busy} onChange={setProfiles} />
      <BackendsInput key={profiles.filter((p) => p.asset.kind === 'terraform-workspace').map((p) => p.asset.name).join(' ')} profiles={profiles} busy={busy} onChange={setProfiles} />
      {t?.readOnly && <ProbeMarksInput t={t} marks={marks} busy={busy} onChange={setMarks} />}
      <LimitsInput draft={limits} busy={busy} problem={saved.ok ? undefined : saved.error} onChange={setLimits} />
      <p className="text-xs text-muted-foreground">A new secret, a new image, a change of tools, a new egress host, a new bastion target or a new profile waits for your approval before any box gets it. A profile you remove loses its approval. Limits apply to the next box with no approval: they give a box nothing.</p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !name.trim() || !image.trim() || !saved.ok || badHost !== undefined || badTarget !== undefined}>Save template</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}
