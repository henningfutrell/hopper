// Issue #708, part 10: a template's agent credential. Its value must be what `claude setup-token` prints — a token good
// for a year that no box renews —, never the credentials file of a `/login`, whose refresh token rotates: one box renewing
// it would sign every other box out. A template may name only one of its own secrets, never a shared secret.
import { describe, expect, it } from 'vitest';
import { agentCredentialProblem, agentCredentialValueProblem } from '../../src/domain/agent-credential.ts';

describe('the agent credential\'s value', () => {
  it('a setup token is taken, with the line break a paste leaves', () => {
    expect(agentCredentialValueProblem('CLAUDE', 'sk-ant-oat01-AbC_d-0123456789')).toBeUndefined();
    expect(agentCredentialValueProblem('CLAUDE', 'sk-ant-oat01-AbC_d-0123456789\n')).toBeUndefined();
  });

  it('anything else is refused, and the refusal never says the value', () => {
    for (const value of [
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-secret-0123', refreshToken: 'sk-ant-ort01-secret-4567' } }),
      'sk-ant-ort01-refresh-token-0123456789', 'sk-ant-api03-api-key-0123456789', 'sk-ant-oat01-', 'sk-ant-oat01-has space-0123', '',
    ]) {
      const problem = agentCredentialValueProblem('CLAUDE', value);
      expect(problem, value).toMatch(/^CLAUDE is not a Claude token: set it to what `claude setup-token` prints/);
      if (value) expect(problem).not.toContain(value);
    }
  });
});

describe('the template\'s agent credential', () => {
  it('is one of its secrets', () => {
    expect(agentCredentialProblem('CLAUDE', ['KUBE_TOKEN', 'CLAUDE'])).toBeUndefined();
    expect(agentCredentialProblem('CLAUDE', ['KUBE_TOKEN'])).toMatch(/the agent credential CLAUDE is not one of the template's secrets/);
  });

  it('is never a shared secret', () => {
    expect(agentCredentialProblem('shared/CLAUDE', ['shared/CLAUDE'])).toMatch(/a shared secret is never an agent credential/);
  });
});
