// Issue #708, part 10: a template's agent credential. Its value must be what `claude setup-token` prints — a token good
// for a year that no box renews —, never the credentials file of a `/login`, whose refresh token rotates: one box renewing
// it would sign every other box out. A template may name only one of its own secrets, never a shared secret.
import { describe, expect, it } from 'vitest';
import { agentCredentialProblem, agentCredentialValueProblem } from '../../src/domain/agent-credential.ts';
import { agentCredentials } from '../../src/vault/agent-credential.ts';

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

// Issue #1287: a job pod's agent credential. The kubernetes executor names one of the job's user's vault secrets; the
// vault gives it to the job's pod only when its value is a setup token, and says what it gave, never the value.
describe('a job pod\'s agent credential', () => {
  const TOKEN = 'sk-ant-oat01-pod-credential-0123456789';
  function vaultWith(secrets: Record<string, string>, o: { backendRefuses?: boolean } = {}) {
    const events: { type: string; jobId?: string; machineId?: string; data: Record<string, unknown> }[] = [];
    const store = {
      vault: { get: (name: string) => (name in secrets ? { id: name, name } : undefined), template: () => undefined },
      events: { append: (e: (typeof events)[number]) => { events.push(e); } },
    } as unknown as Parameters<typeof agentCredentials>[0];
    const valueOf = async (s: { name: string }) => (o.backendRefuses ? { refused: 'the backend did not answer' } : { value: secrets[s.name]! });
    return { events, vault: agentCredentials(store, valueOf as never) };
  }
  const ask = { name: 'CLAUDE_TOKEN', pod: 'hopper-job-j1', job: 'j1' };

  it('gives a setup token, and records the give without the value', async () => {
    const v = vaultWith({ CLAUDE_TOKEN: `${TOKEN}\n` });
    expect(await v.vault.podCredential(ask)).toEqual({ name: 'CLAUDE_TOKEN', value: TOKEN });
    expect(v.events).toEqual([{ type: 'vault.pod_credential_given', jobId: 'j1', machineId: 'hopper-job-j1', data: { name: 'CLAUDE_TOKEN', pod: 'hopper-job-j1', job: 'j1' } }]);
  });

  it('gives nothing, and refuses nothing, when the user holds no such secret: the pod starts signed out', async () => {
    const v = vaultWith({});
    expect(await v.vault.podCredential(ask)).toEqual({ none: true });
    expect(v.events).toEqual([]);
  });

  it('a usage read on a lane pod (no job) is given the token, and nothing is recorded: it reads every few minutes', async () => {
    const v = vaultWith({ CLAUDE_TOKEN: TOKEN });
    expect(await v.vault.podCredential({ name: 'CLAUDE_TOKEN', pod: 'hopper-lanes-0' })).toEqual({ name: 'CLAUDE_TOKEN', value: TOKEN });
    const bad = vaultWith({ CLAUDE_TOKEN: 'not a token' });
    expect(await bad.vault.podCredential({ name: 'CLAUDE_TOKEN', pod: 'hopper-lanes-0' })).toEqual({ refused: expect.stringMatching(/CLAUDE_TOKEN is not a Claude token/) });
    expect([...v.events, ...bad.events]).toEqual([]);
  });

  it('refuses a value that is no setup token, a shared or a system secret, and a backend that cannot read it', async () => {
    const bad = vaultWith({ CLAUDE_TOKEN: JSON.stringify({ claudeAiOauth: { refreshToken: 'sk-ant-ort01-x-0123456789' } }) });
    const r = await bad.vault.podCredential(ask);
    expect(r).toEqual({ refused: expect.stringMatching(/CLAUDE_TOKEN is not a Claude token/) });
    expect(JSON.stringify(bad.events)).not.toContain('sk-ant-ort01');
    expect(bad.events).toMatchObject([{ type: 'vault.refused', jobId: 'j1', machineId: 'hopper-job-j1', data: { name: 'CLAUDE_TOKEN', machine: 'hopper-job-j1' } }]);
    expect(await vaultWith({ 'shared/CLAUDE': TOKEN }).vault.podCredential({ ...ask, name: 'shared/CLAUDE' })).toEqual({ refused: expect.stringMatching(/a shared secret is never an agent credential/) });
    expect(await vaultWith({ 'system/x': TOKEN }).vault.podCredential({ ...ask, name: 'system/x' })).toEqual({ refused: expect.stringMatching(/a system secret is never an agent credential/) });
    expect(await vaultWith({ CLAUDE_TOKEN: TOKEN }, { backendRefuses: true }).vault.podCredential(ask)).toEqual({ refused: 'the backend did not answer' });
  });
});
