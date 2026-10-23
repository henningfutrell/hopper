// Issue #1781 part 3 (design.md "The infrastructure topology"): what one user's discovery reads, the clusters it reads after
// the accounts, an account the vault minted nothing for, and the schedule: one run per user and slot, whichever hopper
// begins it. Pure, and the schedule over fake sagas.
//
// Feature: the hopper discovers each user's topology on a schedule and when a person asks
//   Scenario: the targets are the accounts and clusters the minting credentials mint for, each once
//   Scenario: the clusters EKS listed are read by their ARN; a cluster of its own credential or an override that no account
//     listed, by its name; an EKS alias an override names, by the override's name
//   Scenario: a cluster source of discovery that never held a snapshot, and that a run did not report, is forgotten
//   Scenario: each region of an account is read; the global lists (IAM, S3) in the home region only
//   Scenario: an account the vault minted nothing for reports each of its kept sources as failed
//   Scenario: the schedule begins one run per user and slot, and none for a user whose vault mints for nothing
import { describe, expect, it } from 'vitest';
import {
  accountUnread, askedKey, clustersToRead, DISCOVERY_EVERY_MS, DISCOVERY_REPORTER, discoveryTargets, inBatches, neverReadClusters, regionsToRead, scheduledKey,
} from '../../src/domain/topology-discovery.ts';
import { createTopologyDiscoveries, TOPOLOGY_DISCOVERY_SAGA, type TopologyDiscovery } from '../../src/infra-plans/topology-discovery.ts';
import type { Saga } from '../../src/domain/sagas.ts';
import type { SourceReport, TopologySource } from '../../src/domain/topology.ts';

describe('what a discovery run reads', () => {
  it('reads each account and each cluster a minting credential mints for, once', () => {
    expect(discoveryTargets([
      { mints: { kind: 'aws-account', name: '222222222222' } }, { mints: { kind: 'aws-account', name: '111111111111' } },
      { mints: { kind: 'aws-account', name: '111111111111' } }, { mints: { kind: 'cluster', name: 'lab' } }, {}, { mints: { kind: 'namespace', name: 'lab/shop' } },
    ])).toEqual({ accounts: ['111111111111', '222222222222'], clusters: ['lab'] });
  });

  it('reads the clusters EKS listed by their ARN, then a cluster of its own credential or an override no account listed, by its name', () => {
    const prod = { name: 'prod', arn: 'arn:aws:eks:eu-west-1:111111111111:cluster/prod' };
    expect(clustersToRead([prod, prod], ['prod', 'lab'], [{ name: 'edge' }, { name: 'lab' }])).toEqual([
      { name: 'prod', id: prod.arn, listed: true }, { name: 'lab', id: 'lab' }, { name: 'edge', id: 'edge' },
    ]);
    // One name in two accounts: both are read, and the vault refuses both.
    const other = { name: 'prod', arn: 'arn:aws:eks:eu-west-1:222222222222:cluster/prod' };
    expect(clustersToRead([prod, other], [])).toEqual([{ name: 'prod', id: prod.arn, listed: true }, { name: 'prod', id: other.arn, listed: true }]);
    // An override names prod-eks for EKS in one account: that cluster is minted for by the hopper's name.
    const alias = { name: 'prod-eks', arn: 'arn:aws:eks:eu-west-1:111111111111:cluster/prod-eks' };
    const there = { name: 'prod-eks', arn: 'arn:aws:eks:eu-west-1:222222222222:cluster/prod-eks' };
    expect(clustersToRead([alias, there], [], [{ name: 'shop', eksName: 'prod-eks', account: '111111111111' }])).toEqual([
      { name: 'shop', id: alias.arn, listed: true }, { name: 'prod-eks', id: there.arn, listed: true },
    ]);
  });

  it('forgets a cluster source of discovery that never held a snapshot and that this run did not report', () => {
    const kept = (cluster: string, reporter: string, good: boolean): TopologySource => ({
      key: `kubernetes/${cluster}`, source: { kind: 'kubernetes', cluster }, reporter, lastRead: { at: 't', ok: good },
      ...(good ? { lastGood: { at: 't', nodes: [], links: [] } } : {}),
    });
    const sources = [
      kept('utility', DISCOVERY_REPORTER, false), kept('arn:aws:eks:us-east-2:111111111111:cluster/utility-eks', DISCOVERY_REPORTER, false),
      kept('prod', DISCOVERY_REPORTER, true), kept('lab', 'a check', false),
      { key: 'aws/111111111111/eu-west-1', source: { kind: 'aws', account: '111111111111', region: 'eu-west-1' }, reporter: DISCOVERY_REPORTER, lastRead: { at: 't', ok: false } } satisfies TopologySource,
    ];
    expect(neverReadClusters(sources, ['arn:aws:eks:us-east-2:111111111111:cluster/utility-eks'])).toEqual(['kubernetes/utility']);
  });

  it('reads each region of an account but the home region without the global lists, and the home region alone when none are listed', () => {
    expect(regionsToRead('us-east-1', ['us-east-2', 'us-east-1', 'eu-west-1', 'us-east-2'])).toEqual([
      { region: 'us-east-1', home: true }, { region: 'eu-west-1', home: false }, { region: 'us-east-2', home: false },
    ]);
    expect(regionsToRead('us-east-1', [])).toEqual([{ region: 'us-east-1', home: true }]);
  });

  it('reports each kept source of an account the vault minted nothing for as failed, so its snapshot says why', () => {
    const kept = (source: TopologySource['source']): TopologySource => ({ key: 'k', source, reporter: 'r', lastRead: { at: 't', ok: true } });
    const sources = [kept({ kind: 'aws', account: '111111111111', region: 'eu-west-1' }), kept({ kind: 'aws', account: '222222222222', region: 'eu-west-1' }), kept({ kind: 'kubernetes', cluster: 'lab' })];
    expect(accountUnread(sources, '111111111111', 'no read session')).toEqual([{ source: { kind: 'aws', account: '111111111111', region: 'eu-west-1' }, ok: false, error: 'no read session' }]);
    expect(accountUnread(sources, '333333333333', 'no read session')).toEqual([]);
  });

  it('keys a scheduled run by its user and slot, an asked run by its own id, and reports at most a batch at a time', () => {
    const at = new Date(DISCOVERY_EVERY_MS * 100 + 5);
    expect(scheduledKey('u1', at)).toBe('u1/scheduled/100');
    expect(scheduledKey('u1', new Date(at.getTime() + DISCOVERY_EVERY_MS - 10))).toBe('u1/scheduled/100');
    expect(scheduledKey('u1', new Date(at.getTime() + DISCOVERY_EVERY_MS))).toBe('u1/scheduled/101');
    expect(askedKey('u1', 'a')).toBe('u1/asked/a');
    const r: SourceReport = { source: { kind: 'kubernetes', cluster: 'lab' }, ok: false, error: 'x' };
    expect(inBatches([r, r, r], 2).map((b) => b.length)).toEqual([2, 1]);
  });
});

describe('the schedule', () => {
  const discovery = (accounts: string[]): TopologyDiscovery => ({
    targets: () => ({ accounts, clusters: [] }), readAccounts: async () => ({ clusters: [] }), readClusters: async () => {},
  });
  const graph = () => ({ nodes: [], links: [], sources: [] });

  it('begins one run per user and slot, and none for a user whose vault mints for nothing', async () => {
    const begun: { kind: string; key: string; userId: string }[] = [];
    const kept = new Map<string, Saga>();
    const sagas = {
      begin(kind: string, key: string, _data: Record<string, unknown>, o: { userId: string }): Saga {
        begun.push({ kind, key, userId: o.userId });
        const s = kept.get(key) ?? ({ id: key, kind, key, userId: o.userId, state: 'done', steps: [], data: {}, nextAt: '', createdAt: '', updatedAt: '' } satisfies Saga);
        kept.set(key, s);
        return s;
      },
      drive: async (id: string) => kept.get(id),
    };
    let now = new Date(DISCOVERY_EVERY_MS * 7);
    const d = createTopologyDiscoveries({
      users: () => [{ id: 'u1', discovery: discovery(['111111111111']), graph }, { id: 'u2', discovery: discovery([]), graph }],
      sagas, now: () => now, log: () => {},
    });
    d.tick(); d.tick();
    expect(begun).toEqual([{ kind: TOPOLOGY_DISCOVERY_SAGA, key: 'u1/scheduled/7', userId: 'u1' }, { kind: TOPOLOGY_DISCOVERY_SAGA, key: 'u1/scheduled/7', userId: 'u1' }]);
    expect(kept.size).toBe(1);
    now = new Date(DISCOVERY_EVERY_MS * 8);
    d.tick();
    expect([...kept.keys()]).toEqual(['u1/scheduled/7', 'u1/scheduled/8']);

    // A person's run is its own, driven to its end, and answers the graph.
    const asked = await d.discover('u2');
    expect(asked).toEqual({ state: 'done', graph: graph() });
    expect(begun.at(-1)).toMatchObject({ key: expect.stringMatching(/^u2\/asked\//), userId: 'u2' });
    expect(await d.discover('nobody')).toBeUndefined();
  });
});
