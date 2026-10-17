// Topology discovery's mints (issue #1781 part 3, design.md "The infrastructure topology"): a read session of an account's
// read role `hopper-read` (`aws-role/<account>/hopper-read`), or a read token for a cluster (`cluster/<name>`), minted as for
// a mint test — the read profile only, the read session policy, 900 s; a cluster with no minting credential of its own
// found in the AWS accounts, its cluster override (the config record `clusters`) applied (issue #1766). The session is
// named for the discovery (`DISCOVERY_MINT_ID`). No job and no template take part, so Access is not asked: the read role
// and the session policy bound what it reads. The minting credential never leaves the vault; `vault.discovery_minted` records each mint and each refusal, never a key or a token.
import type { UserStore } from '../domain/ports.ts';
import type { Asset } from '../domain/access.ts';
import { expiryOf, mintKindFor, mintTarget, type Minted, type MintReach } from '../domain/minting.ts';
import { mintSourceFor } from '../domain/cluster-discovery.ts';
import { DISCOVERY_MINT_ID } from '../domain/topology-discovery.ts';
import { readClusters } from './clusters.ts';
import { fromOf, usedOf, type MintFrom } from './mint.ts';

/** The minted read credential, where it is used and the minting credential it came from; or why there is none. */
export type DiscoveryMintAnswer = { minted: Minted; reach: MintReach; credential: string } | { refused: string };

export function createDiscoveryMinting(store: Pick<UserStore, 'vault' | 'events' | 'config'>): (asset: Asset, from: MintFrom) => Promise<DiscoveryMintAnswer> {
  const { vault, events } = store;
  return async (asset, from) => {
    const refuse = (reason: string, credential?: string): DiscoveryMintAnswer => {
      events.append({ type: 'vault.discovery_minted', data: { asset, ...(credential ? { credential } : {}), reason } });
      return { refused: reason };
    };
    const kind = asset.kind === 'aws-role' || asset.kind === 'cluster' ? mintKindFor(asset.kind) : undefined;
    if (!kind) return refuse(`topology discovery mints for an aws-role or a cluster, not ${asset.kind}/${asset.name}`);
    const target = mintTarget(kind, { operation: 'read', asset });
    if (typeof target === 'string') return refuse(target);
    const source = mintSourceFor(vault.list(), target, 'read', readClusters(store.config));
    if (typeof source === 'string') return refuse(source);
    const own = 'credential' in source ? source.credential.name : undefined;
    const made = await from(fromOf(source), target, DISCOVERY_MINT_ID).catch((e: unknown) => ({ refused: (e as Error).message }));
    if ('refused' in made) return refuse(made.refused, own);
    const credential = usedOf(source, made);
    events.append({ type: 'vault.discovery_minted', data: { asset, credential, expiresAt: expiryOf(made.minted) } });
    return { minted: made.minted, reach: made.reach, credential };
  };
}
