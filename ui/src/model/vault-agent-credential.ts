// A template's agent credential on Vault (issue #708, part 10, design.md "The agent credential"): one of its
// own secrets, a Claude token that `claude setup-token` prints, which its boxes start with, signed in. The server
// checks the same rules and stays the authority.

/** What the form offers: the template's own secrets, never a shared one. */
export const agentCredentialChoices = (scope: readonly string[]): string[] => scope.filter((n) => !n.startsWith('shared/'));

/** What a save sends: the choice while its secret is still the template's, else null (none). */
export const agentCredentialOf = (choice: string, scope: readonly string[]): string | null => (choice && agentCredentialChoices(scope).includes(choice) ? choice : null);

/** The template's row: whether its boxes start signed in, or wait for its approval. */
export function agentCredentialText(t: { agentCredential?: string; gives: readonly string[] }): string {
  if (!t.agentCredential) return 'none: sign the agent in once in each box';
  return t.gives.includes(t.agentCredential) ? `${t.agentCredential}: its boxes start signed in` : `${t.agentCredential} (waits): no box starts until you approve it`;
}
