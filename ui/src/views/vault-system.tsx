// Settings → Vault, the hopper's own secrets (issue #658): the vault's system scope — the GitHub connection's tokens,
// the webhook signing secrets, the TypeSafe API key and the sign-in realms' secrets —, each with what it is for, its last
// 4 characters, who set it and when, and where it is changed; and the one audit trail of them. Read-only here: each is
// changed on its own page, and no job can ask for one. No value reaches the page.
import { History, ShieldCheck } from 'lucide-react';
import { Empty, Panel } from '@/components/panel';
import { auditLine, systemSecretLine, systemSecretTitle, systemSecretWhere } from '@/model/vault-system';
import type { VaultView } from '@/model/wire';

export function SystemSecrets({ system }: { system: VaultView['system'] }) {
  const secrets = system?.secrets ?? [];
  const audit = system?.audit ?? [];
  return (
    <Panel title="Hopper's own secrets" icon={ShieldCheck} count={secrets.length || ''} bodyClassName="space-y-3">
      <p className="text-sm text-muted-foreground">Secrets the hopper keeps for itself, in the vault's system scope: sealed, never shown, and never given to a job, a machine or a sandbox box. Each is set on its own page.</p>
      {secrets.length === 0 ? <Empty>None yet.</Empty> : (
        <ul className="space-y-2">
          {secrets.map((s) => (
            <li key={`${s.scope}/${s.name}`} className="space-y-1 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{systemSecretTitle(s)}</span>
                <span className="font-mono text-xs text-muted-foreground break-all">{s.name}</span>
              </div>
              <p className="text-xs break-words">{systemSecretLine(s)}</p>
              <p className="text-xs text-muted-foreground">Changed in {systemSecretWhere(s)}</p>
              {s.problem && <p className="text-xs text-bad break-words">{s.problem}</p>}
            </li>
          ))}
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
