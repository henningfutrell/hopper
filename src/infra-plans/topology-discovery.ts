// Topology discovery inside the hopper (issue #1781 part 3, design.md "The infrastructure topology"): one user's run reads
// each AWS account the vault mints for, with a read session of its read role `hopper-read`, then each Kubernetes cluster —
// those EKS listed and those with a minting credential of their own —, with a read token, and reports what it found as the
// topology sources a read-only check would (`report`, the same mappers). A source that cannot be read is reported failed,
// so it keeps its last good snapshot and the rest of the graph is read. The run is the saga `topology-discovery`, two steps
// (`aws`, `kubernetes`), so a stop between them goes on from the step not done; begun by a person (Discover now) and on a
// schedule, one run per user and slot whichever hopper begins it. Read-only: no compensation, nothing to undo.
import { randomUUID } from 'node:crypto';
import type { Asset } from '../domain/access.ts';
import type { ClusterOverride } from '../domain/clusters.ts';
import type { TopologyReader, UserStore } from '../domain/ports.ts';
import { EKS_READ_ROLE } from '../domain/cluster-discovery.ts';
import { awsTopology, kubeTopology } from '../domain/topology-discover.ts';
import { cleanReport, sourceReportProblem, SOURCES_MAX, type SourceReport, type TopologyGraph } from '../domain/topology.ts';
import {
  accountUnread, askedKey, clustersToRead, DISCOVERY_EVERY_MS, DISCOVERY_REPORTER, discoveryTargets, inBatches, scheduledKey,
  type ClusterToRead, type DiscoveryTargets,
} from '../domain/topology-discovery.ts';
import type { Saga, SagaState } from '../domain/sagas.ts';
import type { SagaDefinition, SagaStepContext } from '../sagas/coordinator.ts';
import type { DiscoveryMintAnswer } from '../vault/discovery-mint.ts';
import type { Topology } from './topology.ts';

export const TOPOLOGY_DISCOVERY_SAGA = 'topology-discovery';

/** One user's discovery: what it reads, and its two steps. */
export interface TopologyDiscovery {
  targets(): DiscoveryTargets;
  /** Reads and reports each account; the clusters to read next. */
  readAccounts(signal: AbortSignal): Promise<{ clusters: ClusterToRead[] }>;
  /** Reads and reports each cluster. */
  readClusters(clusters: readonly ClusterToRead[], signal: AbortSignal): Promise<void>;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createTopologyDiscovery(o: {
  store: Pick<UserStore, 'topology'>; topology: Pick<Topology, 'report'>; reader: TopologyReader;
  secrets(): readonly { mints?: Asset }[]; mint(asset: Asset): Promise<DiscoveryMintAnswer>;
  /** The cluster overrides (issue #1766): an EKS alias is minted for by the hopper's name. */
  overrides?(): readonly ClusterOverride[];
}): TopologyDiscovery {
  /** Each report as `report` takes it: one that is not whole (too many nodes) is reported failed, saying why. */
  const report = (reports: SourceReport[]): void => {
    const whole = reports.map((r): SourceReport => {
      const problem = sourceReportProblem(r);
      return problem ? { source: r.source, ok: false, error: `discovery found more than a source holds: ${problem}` } : cleanReport(r);
    });
    for (const batch of inBatches(whole, SOURCES_MAX)) {
      const r = o.topology.report(DISCOVERY_REPORTER, batch);
      if ('no' in r) throw new Error(`the topology refused discovery's report: ${r.no}`);
    }
  };
  const targets = (): DiscoveryTargets => discoveryTargets(o.secrets());
  return {
    targets,
    async readAccounts(signal) {
      const reports: SourceReport[] = [];
      const listed: Parameters<typeof clustersToRead>[0][number][] = [];
      for (const account of targets().accounts) {
        signal.throwIfAborted();
        const m = await o.mint({ kind: 'aws-role', name: `${account}/${EKS_READ_ROLE}` });
        if ('refused' in m) { reports.push(...accountUnread(o.store.topology.list(), account, `the vault minted no read session: ${m.refused}`)); continue; }
        if (m.minted.kind !== 'aws' || m.reach.kind !== 'aws') continue;
        const source = { kind: 'aws' as const, account, region: m.reach.region };
        try {
          const answers = await o.reader.aws({ account, region: m.reach.region, ...(m.reach.stsEndpoint ? { endpoint: m.reach.stsEndpoint } : {}), session: m.minted }, signal);
          listed.push(...(answers.clusters ?? []));
          reports.push({ source, ok: true, ...awsTopology({ ...answers, account, region: m.reach.region }) });
        } catch (e) {
          reports.push({ source, ok: false, error: messageOf(e) });
        }
      }
      if (reports.length) report(reports);
      return { clusters: clustersToRead(listed, targets().clusters, o.overrides?.() ?? []) };
    },
    async readClusters(clusters, signal) {
      const reports: SourceReport[] = [];
      for (const c of clusters) {
        signal.throwIfAborted();
        const source = { kind: 'kubernetes' as const, cluster: c.id };
        const m = await o.mint({ kind: 'cluster', name: c.name });
        if ('refused' in m) { reports.push({ source, ok: false, error: `the vault minted no read token: ${m.refused}` }); continue; }
        if (m.minted.kind !== 'kube' || m.reach.kind !== 'kube') continue;
        try {
          const ca = m.reach.certificateAuthorityData;
          const answers = await o.reader.kube({ cluster: c.id, name: c.name, server: m.reach.server, ...(ca ? { certificateAuthorityData: ca } : {}), token: m.minted.token }, signal);
          reports.push({ source, ok: true, ...kubeTopology({ ...answers, cluster: c.id, name: c.name }) });
        } catch (e) {
          reports.push({ source, ok: false, error: messageOf(e) });
        }
      }
      if (reports.length) report(reports);
    },
  };
}

/** The saga: `aws`, then `kubernetes` with the clusters `aws` found. `discovery`: undefined while the user's runtime is not loaded. */
export function topologyDiscoverySaga(o: { discovery(userId: string): TopologyDiscovery | undefined }): SagaDefinition {
  const of = (c: SagaStepContext): TopologyDiscovery => {
    const d = c.saga.userId !== undefined ? o.discovery(c.saga.userId) : undefined;
    if (!d) throw new Error(`the runtime of user ${c.saga.userId ?? '(none)'} is not loaded`);
    return d;
  };
  return {
    kind: TOPOLOGY_DISCOVERY_SAGA,
    steps: [
      { name: 'aws', do: async (c) => of(c).readAccounts(c.signal) },
      { name: 'kubernetes', do: async (c) => { await of(c).readClusters((c.data.clusters ?? []) as ClusterToRead[], c.signal); } },
    ],
  };
}

/** What a run a person asked for answers: how the saga ended (or that it goes on), and the graph after it. */
export interface DiscoverAnswer { state: SagaState; error?: string; graph: TopologyGraph }

type Sagas = { begin(kind: string, key: string, data: Record<string, unknown>, o: { userId: string }): Saga; drive(id: string): Promise<Saga | undefined> };

/**
 * Every user's discovery: a person's run (`discover`, driven to its end before it answers), and the schedule, which begins
 * each user's run once per slot (`tick`, every `everyMs`) for a user whose vault mints for an account or a cluster.
 */
export function createTopologyDiscoveries(o: {
  users(): { id: string; discovery: TopologyDiscovery; graph(): TopologyGraph }[]; sagas: Sagas; now(): Date; log(line: string): void; everyMs?: number;
}) {
  let timer: NodeJS.Timeout | undefined;
  const tick = (): void => {
    for (const u of o.users()) {
      try {
        const t = u.discovery.targets();
        if (t.accounts.length || t.clusters.length) o.sagas.begin(TOPOLOGY_DISCOVERY_SAGA, scheduledKey(u.id, o.now()), {}, { userId: u.id });
      } catch (e) {
        o.log(`hopper: topology discovery of user ${u.id}: ${messageOf(e)}`);
      }
    }
  };
  return {
    tick,
    async discover(userId: string): Promise<DiscoverAnswer | undefined> {
      const u = o.users().find((x) => x.id === userId);
      if (!u) return undefined;
      const begun = o.sagas.begin(TOPOLOGY_DISCOVERY_SAGA, askedKey(userId, randomUUID()), {}, { userId });
      const s = (await o.sagas.drive(begun.id)) ?? begun;
      return { state: s.state, ...(s.error ? { error: s.error } : {}), graph: u.graph() };
    },
    start(): void { if (!timer) { tick(); timer = setInterval(tick, o.everyMs ?? DISCOVERY_EVERY_MS / 12); timer.unref(); } },
    stop(): void { if (timer) clearInterval(timer); timer = undefined; },
  };
}

export type TopologyDiscoveries = ReturnType<typeof createTopologyDiscoveries>;
