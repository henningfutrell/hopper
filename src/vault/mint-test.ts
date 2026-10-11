// A mint test (issue #781, design.md "Minting: short-lived credentials"): a person names an `aws-role/<account>/<role>`;
// the vault mints a read session from the minting credential for that account, as it mints one for a job — 900 s, the
// read-only session policy, the session name `awsSessionName` gives —, and asks STS `GetCallerIdentity` with it. The
// answer is the role the session assumed and its session name, so a person sees that a trust policy lets the hopper in
// before a job needs it. No job and no template take part, so Access is not asked: the test is the person's own act, and
// a read session that only says who it is reaches nothing. The minting credential and the minted session never leave
// the vault; `vault.mint_tested` records each test, never a key.
import type { UserStore } from '../domain/ports.ts';
import { MINT_TEST_ID, expiryOf, mintTarget, type MintTestResult } from '../domain/minting.ts';
import { assetOf, type MintFrom } from './mint.ts';

/** A mint test's answer: what STS said, or why there is none — a bad ask, no minting credential, or STS refused. */
export type MintTestAnswer = { tested: MintTestResult } | { refused: string; code: 'invalid' | 'not_found' | 'failed' };

export function createMintTest(o: { store: Pick<UserStore, 'vault' | 'events'> }): (said: string, by: string, from: MintFrom) => Promise<MintTestAnswer> {
  const { vault, events } = o.store;
  return async (said, by, from) => {
    const asset = assetOf(said);
    const refuse = (code: 'invalid' | 'not_found' | 'failed', reason: string, credential?: string): MintTestAnswer => {
      events.append({ type: 'vault.mint_tested', data: { asset: asset ?? said, ...(credential ? { credential } : {}), reason, by } });
      return { refused: reason, code };
    };
    if (!asset) return refuse('invalid', `${said} names no asset: write aws-role/<account>/<role>`);
    const target = mintTarget('aws', { operation: 'read', asset });
    if (typeof target === 'string') return refuse('invalid', target);
    if (target.kind !== 'aws') return refuse('invalid', 'a mint test mints an aws session only');
    const credential = vault.list().find((s) => s.mints?.kind === target.mintsFor.kind && s.mints.name === target.mintsFor.name);
    if (!credential) return refuse('not_found', `no minting credential mints for ${target.mintsFor.kind} ${target.mintsFor.name}: a person adds one on Settings → Vault`);
    const made = await from(credential.name, target, MINT_TEST_ID, true);
    if ('refused' in made) return refuse('failed', made.refused, credential.name);
    if (!made.identity || !made.sessionName) return refuse('failed', `the vault minted from ${credential.name} but said no identity`, credential.name);
    const tested: MintTestResult = {
      asset, credential: credential.name, roleArn: target.roleArn, sessionName: made.sessionName, durationSeconds: target.durationSeconds,
      policyArns: target.policyArns, expiresAt: new Date(expiryOf(made.minted)).toISOString(), identity: made.identity,
    };
    events.append({ type: 'vault.mint_tested', data: { asset, credential: credential.name, sessionName: made.sessionName, arn: made.identity.arn, expiresAt: tested.expiresAt, by } });
    return { tested };
  };
}
