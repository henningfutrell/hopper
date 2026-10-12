// Stack resources (issue #947, design.md "Stack resources"): what each container of the hopper's own stack and each
// sandbox box uses now, read from the container runtime, and what its Postgres does, read from Postgres itself. The
// machine resources (issue #560) are each machine's; these are each service's, with the service as their label.

/** Where a container is: a service of the hopper's compose stack, or a sandbox box the hopper started. */
export const CONTAINER_GROUPS = ['stack', 'sandbox'] as const;
export type ContainerGroup = (typeof CONTAINER_GROUPS)[number];

/** One container now, as the container runtime says. A value the runtime did not give is absent. */
export interface ContainerReading {
  /** The label: the compose service's name, or the box's container name. */
  service: string;
  group: ContainerGroup;
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
  /** Memory in use, less the page cache it could drop. */
  memUsedBytes?: number;
  /** Its memory limit; absent when it has none (it may use the computer's). */
  memLimitBytes?: number;
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

/** `GET /api/resources` (issue #947): every container of the stack and each sandbox box, Postgres and OpenFGA, now. */
export interface StackResources {
  at: string;
  containers: ContainerReadings;
  postgres: PostgresReading | { problem: string };
  openfga: OpenFgaReading | { problem: string };
}
