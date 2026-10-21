// Issue #716, item 1: the read policy on Vault, the page's pure model. The admin types the entries one per
// line (or comma- or space-separated); the panel says what the policy lets the hopper do with no person.
import { describe, expect, it } from 'vitest';
import { readPolicyEntries, readPolicyText } from '../../ui/src/model/vault-read-policy.ts';

describe('the read policy on the page (issue #716)', () => {
  it('reads the entries typed, each once; none clears it', () => {
    expect(readPolicyEntries('')).toEqual([]);
    expect(readPolicyEntries('cluster/lab\n aws-account/* ,namespace/lab/*\ncluster/lab')).toEqual(['cluster/lab', 'aws-account/*', 'namespace/lab/*']);
  });

  it('says what the policy lets the hopper approve with no person', () => {
    expect(readPolicyText([])).toBe('Empty: every template a job asks for waits for a person.');
    expect(readPolicyText(['cluster/lab', 'aws-account/*'])).toBe('Read on 2 entries is approved with no person, for a template a job asks for. Write, sync and apply always wait for a person.');
    expect(readPolicyText(['cluster/lab'])).toBe('Read on 1 entry is approved with no person, for a template a job asks for. Write, sync and apply always wait for a person.');
  });
});
