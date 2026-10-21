// Issue #708, part 10: a template's agent credential on Vault, the page's pure model. The form offers only
// the template's own secrets, never a shared one, and drops the choice when its secret leaves the template; the template
// says whether its boxes start signed in, and when its agent credential still waits for approval.
import { describe, expect, it } from 'vitest';
import { agentCredentialChoices, agentCredentialOf, agentCredentialText } from '../../ui/src/model/vault-agent-credential.ts';

describe('the agent credential on the page (issue #708)', () => {
  it('the form offers the template\'s own secrets, never a shared one', () => {
    expect(agentCredentialChoices(['KUBE_TOKEN', 'CLAUDE', 'shared/GH'])).toEqual(['KUBE_TOKEN', 'CLAUDE']);
  });

  it('a choice whose secret left the template is none: the save sends null', () => {
    expect(agentCredentialOf('CLAUDE', ['KUBE_TOKEN', 'CLAUDE'])).toBe('CLAUDE');
    expect(agentCredentialOf('CLAUDE', ['KUBE_TOKEN'])).toBeNull();
    expect(agentCredentialOf('', ['KUBE_TOKEN'])).toBeNull();
  });

  it('says whether the template\'s boxes start signed in', () => {
    expect(agentCredentialText({ gives: ['CLAUDE'] })).toBe('none: sign the agent in once in each box');
    expect(agentCredentialText({ agentCredential: 'CLAUDE', gives: ['CLAUDE'] })).toBe('CLAUDE: its boxes start signed in');
    expect(agentCredentialText({ agentCredential: 'CLAUDE', gives: [] })).toBe('CLAUDE (waits): no box starts until you approve it');
  });
});
