// Vault, the hopper's own secrets (issue #658): the vault's system scope — the GitHub connection's tokens,
// the webhook signing secrets, the TypeSafe API key and the sign-in realms' secrets —, each with what it is for, its last
// 4 characters, who set it and when, and where it is changed; and the one audit trail of them. Each is changed on its own
// page; here an admin may only keep a user's TypeSafe key or webhook secret in a vault backend (issue #658, requirement
// 6), which the hopper then reads there and holds in memory only. No job can ask for one. No value reaches the page.
import { DatabaseZap, History, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Empty, Panel } from '@/components/panel';
import { Label } from '@/components/vault-fields';
import { referenceHint } from '@/model/vault';
import { auditLine, mayKeepInBackend, systemSecretLine, systemSecretTitle, systemSecretWhere } from '@/model/vault-system';
import type { SystemSecretView, VaultBackendView, VaultView } from '@/model/wire';
import type { Send } from './vault';

/** Where a vault backend keeps it: the backend, and the reference there. */
function BackendForm({ s, backends, busy, send, onDone }: { s: SystemSecretView; backends: VaultBackendView[]; busy: boolean; send: Send; onDone: () => void }) {
  const [kept, setKept] = useState(s.backend?.name ?? backends[0]?.name ?? '');
  const [reference, setReference] = useState(s.backend?.reference ?? '');
  const backend = backends.find((b) => b.name === kept);
  return (
    <form className="space-y-2" onSubmit={async (e) => {
      e.preventDefault();
      if (!backend) return;
      if (await send({ action: 'system-in-backend', name: s.name, backend: backend.name, reference: reference.trim() }, `${systemSecretTitle(s)}: kept in ${backend.name}`)) onDone();
    }}>
      <div className="space-y-1"><Label>Vault backend</Label>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Vault backend">
          {backends.map((b) => (
            <button key={b.name} type="button" role="radio" aria-checked={kept === b.name} onClick={() => setKept(b.name)}
              className={`min-h-8 rounded-md border px-2 text-xs transition-colors ${kept === b.name ? 'border-primary bg-primary text-primary-foreground' : 'border-input text-muted-foreground hover:bg-muted'}`}>{b.name}</button>
          ))}
        </div>
      </div>
      {backend && (
        <label className="block space-y-1"><Label>Where it is in {backend.name} — read at start, when set and every 5 minutes; held in memory only</Label>
          <Input className="h-9 font-mono text-sm" value={reference} required maxLength={500} autoCapitalize="off" autoCorrect="off" spellCheck={false}
            placeholder={referenceHint(backend.plugin)} onChange={(e) => setReference(e.target.value)} />
          {(backend.problem ?? backend.setup) && <div className="text-xs text-warn break-words">{backend.problem ?? backend.setup}</div>}</label>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy || !backend || reference.trim() === ''}>Keep it there</Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

function SystemSecretItem({ s, backends, can, busy, send }: { s: SystemSecretView; backends: VaultBackendView[]; can: boolean; busy: boolean; send: Send }) {
  const [moving, setMoving] = useState(false);
  return (
    <li className="space-y-1 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{systemSecretTitle(s)}</span>
        <span className="font-mono text-xs text-muted-foreground break-all">{s.name}</span>
      </div>
      <p className="text-xs break-words">{systemSecretLine(s)}</p>
      <p className="text-xs text-muted-foreground">Changed in {systemSecretWhere(s)}</p>
      {s.problem && <p className="text-xs text-bad break-words">{s.problem}</p>}
      {mayKeepInBackend(s) && backends.length > 0 && (moving
        ? <BackendForm s={s} backends={backends} busy={busy} send={send} onDone={() => setMoving(false)} />
        : <Button size="sm" variant="outline" disabled={!can || busy} onClick={() => setMoving(true)}><DatabaseZap />{s.backend ? 'Change backend' : 'Keep in a vault backend'}</Button>)}
    </li>
  );
}

export function SystemSecrets({ system, backends, can, busy, send }: { system: VaultView['system']; backends: VaultBackendView[]; can: boolean; busy: boolean; send: Send }) {
  const secrets = system?.secrets ?? [];
  const audit = system?.audit ?? [];
  return (
    <Panel title="Hopper's own secrets" icon={ShieldCheck} count={secrets.length || ''} bodyClassName="space-y-3">
      <p className="text-sm text-muted-foreground">Secrets the hopper keeps for itself, in the vault's system scope: sealed, never shown, and never given to a job, a machine or a sandbox box. Each is set on its own page. A TypeSafe key or a webhook secret can instead be kept in a vault backend: the hopper reads it there and holds it in memory only.</p>
      {secrets.length === 0 ? <Empty>None yet.</Empty> : (
        <ul className="space-y-2">
          {secrets.map((s) => <SystemSecretItem key={`${s.scope}/${s.name}`} s={s} backends={backends} can={can} busy={busy} send={send} />)}
        </ul>
      )}
      <div className="space-y-1">
        <h3 className="flex items-center gap-1 text-sm font-medium"><History className="size-4" />Audit trail</h3>
        {audit.length === 0 ? <Empty>Nothing yet.</Empty> : (
          <ul className="space-y-0.5 text-xs">{audit.map((e) => <li key={e.seq} className="break-words">{auditLine(e)}</li>)}</ul>
        )}
      </div>
    </Panel>
  );
}
