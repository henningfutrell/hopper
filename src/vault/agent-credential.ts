// A launch's agent credential (issue #708, part 10, design.md "The agent credential"): the value the vault gives a box
// at its launch, so its agent starts signed in. Asked for once per launch, before anything of the box is made, and only
// by the sandbox module: no job and no machine asks. Given only when the template's approved scope holds the secret and
// the launch's scope names it, and only when the value is a Claude token. Every give and refusal is an event, never
// with the value.
import { agentCredentialValueProblem } from '../domain/agent-credential.ts';
import type { UserStore } from '../domain/ports.ts';
import { givesOf, type VaultSecret } from '../domain/vault.ts';

export { agentCredentialProblem } from '../domain/agent-credential.ts';

/** A launch asks: the template, the secrets its launch resolved to, and the box's name. */
export interface AgentCredentialAsk { template: string; secrets: readonly string[]; box: string }

/** The value and the secret's name; `none`: the template names none, or the launch leaves it out; or why not. */
export type AgentCredentialAnswer = { name: string; value: string } | { none: true } | { refused: string };

export interface AgentCredentials {
  /** The agent credential a launch of `ask.template` starts its box with (issue #708, part 10). */
  agentCredential(ask: AgentCredentialAsk): Promise<AgentCredentialAnswer>;
}

export function agentCredentials(store: Pick<UserStore, 'vault' | 'events'>, valueOf: (s: VaultSecret) => Promise<{ value: string } | { refused: string }>): AgentCredentials {
  const { vault, events } = store;
  return {
    async agentCredential(ask) {
      const t = vault.template(ask.template);
      const name = t?.agentCredential;
      if (!t || name === undefined) return { none: true };
      const refuse = (reason: string, backend?: string): { refused: string } => {
        events.append({ type: 'vault.refused', machineId: ask.box, data: { name, machine: ask.box, template: t.name, ...(backend ? { backend } : {}), reason } });
        return { refused: reason };
      };
      // Checked before the launch's scope: a template whose agent credential waits for approval starts no box at all.
      if (!givesOf(t).includes(name)) return refuse(`${t.name} is not approved for its agent credential ${name}: approve it in Settings → Vault, or name no agent credential`);
      if (!ask.secrets.includes(name)) return { none: true };
      const secret = vault.get(name);
      if (!secret) return refuse(`the vault holds no secret ${name}`);
      const r = await valueOf(secret);
      if ('refused' in r) return refuse(r.refused, secret.backend?.name);
      const bad = agentCredentialValueProblem(name, r.value);
      if (bad) return refuse(bad, secret.backend?.name);
      events.append({ type: 'vault.agent_credential_given', machineId: ask.box, data: { name, template: t.name, box: ask.box, ...(secret.backend ? { backend: secret.backend.name } : {}) } });
      return { name, value: r.value.trim() };
    },
  };
}
