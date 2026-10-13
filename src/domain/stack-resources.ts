// Stack resources (issue #947, design.md "Stack resources"): what each container of the hopper's own stack and each
// sandbox box uses now, read from the container runtime, and what its Postgres does, read from Postgres itself. The
// machine resources (issue #560) are each machine's; these are each service's, with the service as their label. The stack
// recorder keeps some of them over time as stack samples (design.md "Stack resources over time").
import type { UsageGap, UsageGraphView, UsagePoint } from './usage-history.ts';

/** Where a container is: a service of the hopper's compose stack, or a sandbox box the hopper started. */
export const CONTAINER_GROUPS = ['stack', 'sandbox'] as const;
export type ContainerGroup = (typeof CONTAINER_GROUPS)[number];

/** One container now, as the container runtime says. A value the runtime did not give is absent. */
export interface ContainerReading {
  /** The label: the compose service's name, or the box's container name; for a box on a client target, `<machine>/<name>`. */
  service: string;
  group: ContainerGroup;
  /** The client target a sandbox box runs on, through its remote runtime; absent: the computer the hopper runs on. */
  machine?: string;
  /** The container's own name and image. */
  name: string;
  image: string;
  /** The runtime's own word: `running`, `exited`, `restarting`, … */
  state: string;
  /** Its health check's word (`healthy`, `unhealthy`, `starting`), when it has one. */
  health?: string;
  /** When it last started (ISO), while it runs. */
  startedAt?: string;
  /** How often its restart policy restarted it. */
  restarts?: number;
  /** CPU cores busy since the read before (1 = one core); absent at a first read. */
  cpuCores?: number;
  /** The CPU cores it may use, when a quota is set. */
  cpuLimitCores?: number;
  /** The CPU cores it sees: the runtime's online CPUs. */
  cores?: number;
  /** Memory in use, less the page cache it could drop. */
  memUsedBytes?: number;
  /** Its memory limit; absent when it has none (it may use the computer's). */
  memLimitBytes?: number;
  /** The most memory it may use, as the runtime's stats say: its limit, else the computer's. */
  memMaxBytes?: number;
  /** Bytes in and out over its networks, since it started. */
  netRxBytes?: number;
  netTxBytes?: number;
  /** Bytes read from and written to disk, since it started. */
  diskReadBytes?: number;
  diskWriteBytes?: number;
  /** Its writable layer's size. */
  layerBytes?: number;
  /** The named volumes it mounts, with their size when the runtime says. */
  volumes?: { name: string; bytes?: number }[];
}

/** The containers now, or why they cannot be read (no runtime socket, the runtime not reached). */
export type ContainerReadings = { containers: ContainerReading[] } | { problem: string };

/** What the container runtime is read through (issue #947): its socket, the same one sandbox boxes start through. */
export interface ContainerMeter {
  read(): Promise<ContainerReadings>;
}

/**
 * The sandbox boxes on one client target (issue #947), read through its remote runtime — the machine's own Podman (else
 * Docker), through its client —, or why they cannot be read (no such client target now, no runtime there).
 */
export type MachineBoxes = { machine: string; containers: ContainerReading[] } | { machine: string; problem: string };

/** What reads the sandbox boxes on each client target that holds one of the hopper's sandbox records. Never throws. */
export interface RemoteBoxMeter {
  read(): Promise<MachineBoxes[]>;
}

/** The hopper's Postgres now (issue #947). */
export interface PostgresReading {
  /** Connections: active (running a statement), all, and the most it allows. */
  connections: { active: number; total: number; max: number };
  /** The hopper's database's size. */
  databaseBytes: number;
  /** The share of block reads served from its cache since its statistics were reset; absent before any read. */
  cacheHitFrac?: number;
  /** Lock requests waiting now. */
  locksWaiting: number;
  /** Transactions open longer than LONG_TRANSACTION_S, and how long the oldest open transaction is open (seconds). */
  longTransactions: number;
  oldestTransactionS?: number;
  /** Statement latency from pg_stat_statements: calls and mean time since its reset; or why there is none. */
  statements: { calls: number; meanMs: number } | { problem: string };
}

/** A transaction open longer than this is a long one. */
export const LONG_TRANSACTION_S = 300;

/** What reads the hopper's Postgres (the store, issue #947). */
export interface DatabaseStats {
  read(): PostgresReading;
}

/** OpenFGA's checks since it started, from its own metrics endpoint (issue #947). */
export interface OpenFgaReading {
  /** Checks it answered, and of those the ones that failed (any gRPC code but OK). */
  checks: number;
  errors: number;
  /** The mean time of a check, in ms, as OpenFGA measures it; absent before any check. */
  meanMs?: number;
}

/** What reads OpenFGA's metrics endpoint (issue #947). A read that fails throws, with why. */
export interface OpenFgaMeter {
  read(): Promise<OpenFgaReading>;
}

/** The search index's Solr now (issue #947), from its own metrics API: requests to the core's `/select`, its documents. */
export interface SolrReading {
  /** Queries, and of those the ones that failed, since the core was loaded. */
  queries: number;
  errors: number;
  /** The mean and the 95th percentile time of a query, in ms, as Solr's timer has them (the last minutes weigh most); absent before any query. */
  meanMs?: number;
  p95Ms?: number;
  /** The documents in the index, and the index's size on disk. */
  docs: number;
  indexBytes: number;
}

/** What reads Solr's metrics API (issue #947). A read that fails throws, with why. */
export interface SolrMeter {
  read(): Promise<SolrReading>;
}

/**
 * Solr in `GET /api/resources`: its reading, or why it cannot be read; with `pending`, the documents waiting to be
 * indexed — every user's pending index updates (issue #945), which grow while Solr is down. No search set up: none.
 */
export type SolrPart = (SolrReading & { pending: number }) | { problem: string; pending?: number };

/**
 * `GET /api/resources` (issue #947): every container of the stack and each sandbox box beside the hopper, the sandbox
 * boxes on each client target, Postgres, OpenFGA and Solr, now.
 */
export interface StackResources {
  at: string;
  containers: ContainerReadings;
  /** Per client target that holds a sandbox box, by its name. */
  remoteBoxes: MachineBoxes[];
  postgres: PostgresReading | { problem: string };
  openfga: OpenFgaReading | { problem: string };
  solr: SolrPart;
}

/**
 * What the stack's resource graph draws per service (issue #947), each a share, 0..1: a container's CPU (of its CPU quota,
 * else of the cores it sees) and memory (of the most it may use), Postgres's connections (of `max_connections`), and
 * OpenFGA's checks that failed since the record before.
 */
export const STACK_METRICS = ['cpu', 'memory', 'connections', 'check-errors'] as const;
export type StackMetric = (typeof STACK_METRICS)[number];

/** One service's metric at one time: what the stack recorder keeps. */
export interface StackSample {
  at: string;
  /** The label: a container's service, `postgres` for Postgres's own metrics, `openfga` for OpenFGA's. */
  service: string;
  group: ContainerGroup;
  metric: StackMetric;
  /** A share, 0..1. */
  value: number;
}

/** One line of the stack's resource graph: per graph step its peak share; the gaps where the service gave no sample. */
export interface StackSeries {
  service: string;
  group: ContainerGroup;
  metric: StackMetric;
  points: UsagePoint[];
  gaps: UsageGap[];
}

/** The stack's resources over time (issue #947): stack samples in the instance schema. */
export interface StackHistoryRepository {
  /** Keep stack samples; one already kept (same service, metric and time) is kept once. How many were new. */
  record(samples: readonly StackSample[]): number;
  /** The stack's resource graph's lines over [from, to), ordered by service and metric. */
  series(q: { from: Date; to: Date; stepMs: number; originMs: number }): StackSeries[];
  /** Delete the samples older than `before`; how many. */
  prune(before: Date): number;
}

/** How long stack samples are kept: a sample a minute per service and metric adds up. */
export const STACK_HISTORY_RETENTION_DAYS = 30;

/** `GET /api/resources/history` (issue #947): the stack's resource graph. */
export interface StackHistory {
  view: UsageGraphView;
  from: string;
  to: string;
  stepMs: number;
  retentionDays: number;
  series: StackSeries[];
}
