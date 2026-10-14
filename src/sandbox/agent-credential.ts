// The agent credential at launch (issue #708, part 10, design.md "The agent credential"): a box of a template that names
// one starts with it in its environment, so the box's herdr and every job pane in it have the agent signed in. The vault
// decides (src/vault/agent-credential.ts); this asks it once per launch, before anything of the box is made.
import { AGENT_CREDENTIAL_VARIABLE } from '../domain/agent-credential.ts';
import type { AgentCredentialAnswer, AgentCredentialAsk } from '../vault/agent-credential.ts';

/** A user's vault, as a launch asks it for the agent credential. */
export type AgentCredentialOf = (userId: string, ask: AgentCredentialAsk) => Promise<AgentCredentialAnswer>;

/** The agent credential over the users' runtimes: each one asks its own vault. */
export const usersAgentCredentials = (all: () => readonly { user: { id: string }; vault: { agentCredential(ask: AgentCredentialAsk): Promise<AgentCredentialAnswer> } }[]): AgentCredentialOf =>
  async (userId, ask) => all().find((rt) => rt.user.id === userId)?.vault.agentCredential(ask) ?? { refused: `no user ${userId}` };

/**
 * What the box's environment and record get: the variable and the secret's name, or nothing (no template, none named,
 * left out of the launch's scope). Throws `refuse(reason)` when the vault refuses: the launch makes nothing.
 */
export async function launchCredential(
  ask: ((a: AgentCredentialAsk) => Promise<AgentCredentialAnswer>) | undefined, a: AgentCredentialAsk | undefined, refuse: (reason: string) => Error,
): Promise<{ env: Record<string, string>; name?: string }> {
  if (!ask || !a) return { env: {} };
  const r = await ask(a);
  if ('refused' in r) throw refuse(r.refused);
  return 'none' in r ? { env: {} } : { env: { [AGENT_CREDENTIAL_VARIABLE]: r.value }, name: r.name };
}
