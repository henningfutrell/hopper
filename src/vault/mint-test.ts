// A mint test (issue #781, design.md "Minting: short-lived credentials"): a person names an `aws-role/<account>/<role>`;
// the vault mints a read session from the minting credential for that account, as it mints one for a job — 900 s, the
// read-only session policy, the session name `awsSessionName` gives —, and asks STS `GetCallerIdentity` with it. The
// answer is the role the session assumed and its session name, so a person sees that a trust policy lets the hopper in
// before a job needs it. Or (issue #854) a `cluster/<name>`: the vault mints a read token from the cluster's minting
// credential, as for a job — a TokenRequest token, or an EKS token —, and asks the cluster who it is and which
// namespaces it lists (`kubectl auth whoami`, `kubectl get ns`). No job and no template take part, so Access is not
// asked: the test is the person's own act. The minting credential and what is minted never leave the vault;
// `vault.mint_tested` records each test, never a key or a token. A cluster with no minting credential of its own (issue
// #1766) is found in the AWS accounts, as for a job; the answer names the account, the role and the minting credential.
import type { UserStore } from '../domain/ports.ts';
import type { Asset } from '../domain/access.ts';
import { MINT_TEST_ID, expiryOf, mintTarget, roleAccountOf, type MintTarget, type MintTestResult } from '../domain/minting.ts';
import { mintSourceFor } from '../domain/cluster-discovery.ts';
import { assetOf, fromOf, usedOf, type MintedFrom, type MintFrom } from './mint.ts';

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
    const takes = 'a mint test takes aws-role/<account>/<role> or cluster/<name>';
    if (!asset) return refuse('invalid', `${said} names no asset: ${takes}`);
    if (asset.kind !== 'aws-role' && asset.kind !== 'cluster') return refuse('invalid', `${takes}, not ${asset.kind}/${asset.name}`);
    const target = mintTarget(asset.kind === 'cluster' ? 'kube' : 'aws', { operation: 'read', asset });
    if (typeof target === 'string') return refuse('invalid', target);
    const source = mintSourceFor(vault.list(), target, 'read');
    if (typeof source === 'string') return refuse(source.startsWith('no ') ? 'not_found' : 'invalid', source);
    const made = await from(fromOf(source), target, MINT_TEST_ID, true);
    // The answer names the secret the test used (issue #1761), as a tested answer does; a discovery names its accounts.
    const own = 'credential' in source ? source.credential.name : undefined;
    if ('refused' in made) return refuse('failed', own ? `the mint test used ${own}: ${made.refused}` : made.refused, own);
    const credential = usedOf(source, made);
    const tested = testedOf(made, asset, credential, target);
    if (!tested) return refuse('failed', `the vault minted from ${credential} but said no identity`, credential);
    const who = tested.kind === 'aws' ? { arn: tested.identity.arn } : { user: tested.user.username };
    const role = tested.roleArn ? { roleArn: tested.roleArn, account: roleAccountOf(tested.roleArn) } : {};
    events.append({ type: 'vault.mint_tested', data: { asset, credential, ...role, ...(tested.sessionName ? { sessionName: tested.sessionName } : {}), ...who, expiresAt: tested.expiresAt, by } });
    return { tested };
  };
}

/** The answer of a test that minted: who STS or the cluster says it is; undefined when the vault said no one. */
function testedOf(made: MintedFrom, asset: Asset, credential: string, target: MintTarget): MintTestResult | undefined {
  const expiresAt = new Date(expiryOf(made.minted)).toISOString();
  if (target.kind === 'aws') {
    if (!made.identity || !made.sessionName) return undefined;
    return {
      kind: 'aws', asset, credential, roleArn: target.roleArn,
      sessionName: made.sessionName, durationSeconds: target.durationSeconds, policyArns: target.policyArns, expiresAt, identity: made.identity,
    };
  }
  if (!made.cluster || made.reach.kind !== 'kube') return undefined;
  const via = made.roleArn && made.sessionName ? { roleArn: made.roleArn, account: made.account ?? roleAccountOf(made.roleArn), sessionName: made.sessionName } : {};
  return { kind: 'kube', asset, credential, server: made.reach.server, expiresAt, ...via, ...made.cluster };
}
