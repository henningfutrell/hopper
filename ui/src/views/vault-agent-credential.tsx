// A template's agent credential in its form on Vault (issue #708, part 10): one of its own secrets, a Claude
// token, which its boxes start with, signed in. None: a person signs the agent in once in each box.
import { FIELD } from '@/components/plugin-form';
import { Label } from '@/components/vault-fields';
import { agentCredentialChoices } from '@/model/vault-agent-credential';

export function AgentCredentialInput({ choice, scope, busy, onChange }: { choice: string; scope: string[]; busy: boolean; onChange: (c: string) => void }) {
  const choices = agentCredentialChoices(scope);
  return (
    <label className="block space-y-1"><Label>Agent credential — a token from <span className="font-mono">claude setup-token</span>: its boxes start signed in</Label>
      <select aria-label="Agent credential" className={`${FIELD} w-64 font-mono`} value={choices.includes(choice) ? choice : ''} disabled={busy} onChange={(e) => onChange(e.target.value)}>
        <option value="">none — sign in once in each box</option>
        {choices.map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
    </label>
  );
}
