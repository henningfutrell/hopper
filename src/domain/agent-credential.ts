// A template's agent credential (issue #708, part 10, design.md "The agent credential"): one of its vault secrets, a
// long-lived Claude token that `claude setup-token` prints, which a box of it starts with in its environment, so its
// agent is signed in from the first job. The sign-in in the box (`/login`, kept in its home volume) is the fallback.
import { isSharedSecret } from './vault.ts';

/** The variable the claude CLI signs in with where its login is not on the machine (docs/deploy.md, issue #533). */
export const AGENT_CREDENTIAL_VARIABLE = 'CLAUDE_CODE_OAUTH_TOKEN';

/**
 * What `claude setup-token` prints: an OAuth access token good for a year, which no box renews. A token of a `/login`
 * (`~/.claude/.credentials.json`) is refused: its refresh token rotates, and one box renewing it signs every other out.
 */
const SETUP_TOKEN = /^sk-ant-oat\d\d-[A-Za-z0-9_-]{8,}$/;

/** Why `value` cannot be the agent credential `name`, or undefined. Never says the value. */
export function agentCredentialValueProblem(name: string, value: string): string | undefined {
  return SETUP_TOKEN.test(value.trim()) ? undefined : `${name} is not a Claude token: set it to what \`claude setup-token\` prints (sk-ant-oat…), not a sign-in's credentials file`;
}

/** Why a template with `secrets` cannot name `name` as its agent credential, or undefined. */
export function agentCredentialProblem(name: string, secrets: readonly string[]): string | undefined {
  if (isSharedSecret(name)) return 'a shared secret is never an agent credential: set the token as a vault secret of your own';
  if (!secrets.includes(name)) return `the agent credential ${name} is not one of the template's secrets: add it to them, or name no agent credential`;
  return undefined;
}
