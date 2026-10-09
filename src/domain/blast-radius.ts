// Blast radius (issue #542, design.md "Blast radius and actor machines"): what each machine's discovery found — its
// tools and the access it holds, names and identities only, never a secret —, the reach rated from it, the gate that
// keeps jobs off a machine whose radius is at or above a level, and the actor machines kept for that work on purpose.
// Re-exported by types.ts.
import type { OperationProfile } from './access.ts';
import type { MachineId } from './types.ts';

/** A machine's blast radius, least first. */
export const RADIUS_LEVELS = ['low', 'medium', 'high'] as const;
export type RadiusLevel = typeof RADIUS_LEVELS[number];

/** Where the gate stands: machines rated at or above the level are gated; `off`: none by rating (actor machines still are). */
export const GATE_AT = ['high', 'medium', 'off'] as const;
export type GateAt = typeof GATE_AT[number];

/** How a write discovery could not confirm counts: as a write (fail closed, the default) or as read-only. */
export const UNCONFIRMED_AS = ['write', 'read'] as const;
export type UnconfirmedAs = typeof UNCONFIRMED_AS[number];

/** The prefix of every hold the gate gives. */
export const GATE_HOLD = 'held at the blast-radius gate';

/** One AWS identity: a profile, or the environment's own (`(environment)`: variables, a web identity, an instance role). */
export interface AwsIdentity {
  profile: string;
  account?: string;
  arn?: string;
  region?: string;
  /** Why `sts get-caller-identity` gave no identity. */
  error?: string;
  /** The curated actions, as IAM policy simulation decided them for this identity. Absent: not simulated. */
  simulated?: { action: string; decision: string }[];
  /** Why the simulation gave no answer (no permission to simulate, a root identity, a role with a path). */
  simulationError?: string;
}

/** One kubectl context, and what `auth can-i` said of the curated checks across every namespace. */
export interface KubeContext {
  name: string;
  cluster?: string;
  namespace?: string;
  current: boolean;
  /** `check` e.g. `create deployments`; `answer` yes, no, or the error. */
  can: { check: string; answer: string }[];
}

/** What one discovery found on a machine. Names, identities and scopes only. */
export interface DiscoveryFacts {
  /** The PATH, in order. */
  path: string[];
  /** Every executable on the PATH: its directory and name. */
  bins: { dir: string; name: string }[];
  /** Versions of the known tools found (aws, terraform, tofu, kubectl): the first line each printed. */
  versions: Record<string, string>;
  aws: AwsIdentity[];
  kube: KubeContext[];
  /** Credential sources: the names of credential variables set, and labels of credential files present. */
  credentials: { env: string[]; files: string[] };
}

/** What a machine can reach and how badly: one account, cluster or credential source. */
export interface Reach {
  kind: 'aws' | 'kubernetes' | 'terraform' | 'credential';
  /** What it reaches: an account and identity, a context and cluster, a credential source. */
  target: string;
  /** `admin`: it can grant itself more (IAM writes, every verb on every resource). `unconfirmed`: discovery could not tell. */
  access: 'read' | 'write' | 'admin' | 'unconfirmed';
  prod: boolean;
  /** Why: the facts it was rated from. */
  evidence: string;
}

/** A machine's rating: its level and the reach behind it, each with its evidence. */
export interface Rating {
  level: RadiusLevel;
  reach: Reach[];
  /** One line per reach that set the level. */
  reasons: string[];
}

/** The rules a rating follows, edited by an admin. */
export interface RadiusRules {
  /** A name containing one of these (case ignored) is prod: a profile, account, identity, context, cluster or namespace. */
  prodPatterns: string[];
  /** AWS account ids that are prod whatever their names. */
  prodAccounts: string[];
  unconfirmed: UnconfirmedAs;
}

/** A machine set up on purpose for high-radius work: gated always, its rating checked against what it was declared. */
export interface ActorMachine {
  machineId: MachineId;
  purpose: string;
  expected: RadiusLevel;
}

/** What may pass the gate without a person: a job with one of the labels, from one of the repos, or at or above the priority. */
export interface GatePassRules {
  labels: string[];
  repos: string[];
  /** Absent: priority lets no job through. */
  minPriority?: number;
}

/** The user's blast-radius settings, kept in the database, applied at the next Decision. */
export interface BlastRadiusSettings {
  gateAt: GateAt;
  pass: GatePassRules;
  rules: RadiusRules;
  actors: ActorMachine[];
  /** How often each machine is discovered again, minutes. */
  everyMinutes: number;
}

export const DEFAULT_BLAST_RADIUS_SETTINGS: BlastRadiusSettings = {
  gateAt: 'high',
  pass: { labels: [], repos: [] },
  rules: { prodPatterns: ['prod', 'production', 'prd'], prodAccounts: [], unconfirmed: 'write' },
  actors: [],
  everyMinutes: 60,
};

export const BLAST_RADIUS_BOUNDS = { everyMinutes: { min: 5, max: 1440 }, minPriority: { min: 0, max: 100 } } as const;

/** What a discovery changed since the one before it. Each list holds the names that came or went. */
export interface DiscoveryChanges {
  first: boolean;
  added: string[];
  removed: string[];
  /** The level, when it moved: `from` the level the discovery before gave. */
  level?: { from: RadiusLevel; to: RadiusLevel };
}

/** One machine's last discovery, kept in the user's settings. */
export interface DiscoveryRecord {
  machineId: MachineId;
  at: string;
  /** Absent with `error`: it did not finish. The facts before it are kept in `facts` until one does. */
  facts?: DiscoveryFacts;
  error?: string;
  changes?: DiscoveryChanges;
  /** The level this discovery rated, with the rules then. */
  level?: RadiusLevel;
  /** Set when a discovery raised the level; kept while the level stays there. */
  grew?: { from: RadiusLevel; to: RadiusLevel; at: string };
  /** The actor machine mismatch this discovery found, so the same one is told once. */
  mismatch?: { expected: RadiusLevel; found: RadiusLevel };
}

/** A machine the gate keeps from ordinary placement, and why. */
export interface GatedMachine {
  machineId: MachineId;
  reason: string;
}

/** What the decider reads of the gate (`DecisionInputs.blastRadius`). */
export interface BlastRadiusInput {
  gated: GatedMachine[];
  pass: GatePassRules;
}

/** A job let through the gate by a person: it may run on a gated machine. */
export interface GatePass { at: string }

/** One machine as `GET /api/blast-radius` shows it. */
export interface MachineRadiusView {
  machineId: MachineId;
  label: string;
  online: boolean;
  /** Whether discovery can run there: a container target has no shell the hopper reaches it by. */
  discoverable: boolean;
  discovery?: DiscoveryRecord;
  /** Rated now, with the rules now. Absent: never discovered. */
  rating?: Rating;
  /** Its declaration, when it is an actor machine; `mismatch` when its rating is not the level declared. */
  actor?: ActorMachine & { mismatch: boolean };
  /** Why the gate keeps it from ordinary placement; absent: it is not gated. */
  gated?: string;
}

/** `GET /api/blast-radius`. */
export interface BlastRadiusView {
  settings: BlastRadiusSettings;
  defaults: BlastRadiusSettings;
  machines: MachineRadiusView[];
  /** The AWS actions every identity is simulated for, and which of them make it an admin. */
  awsActions: { write: string[]; admin: string[] };
  /** The kubectl checks every context is asked. */
  kubeChecks: string[];
}

/** One operation profile in a template's rating (issue #584): its level, and whether access holds an approval for it. */
export interface TemplateProfileRadius {
  profile: OperationProfile;
  level: RadiusLevel;
  approved: boolean;
}

/**
 * A template's blast radius (issue #584): what its boxes may do, rated from its operation profiles — declared on the
 * template or approved in access, approved or waiting — and its credential scope, the vault secrets its boxes may ask
 * for. A box's tools decide what it could do (a machine's `Rating`); its template decides what it may do.
 */
export interface TemplateRadius {
  level: RadiusLevel;
  /** One line per profile or vault secret that set the level. */
  reasons: string[];
  profiles: TemplateProfileRadius[];
}

/** A job held at the gate, and whether a person may let it through: waiting, and held there. */
export const heldAtGate = (job: { status: string; holdReason?: string }): boolean =>
  job.status === 'held' && (job.holdReason ?? '').startsWith(GATE_HOLD);
