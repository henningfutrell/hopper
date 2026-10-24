// The vault container's wire (issue #586, design.md "The vault in a container of its own"): what the hopper sends the
// vault server, and the names both sides read. One POST per edit or ask, JSON, with the preshared key as a bearer token.
import { z } from 'zod';
import { VAULT_VALUE_MAX } from '../domain/vault.ts';
import { ASSET_KINDS } from '../domain/access.ts';
import { SQL_MAX } from '../domain/database-read.ts';

/** The preshared key the hopper shows and the vault checks: a runtime secret (also `_FILE`). */
export const VAULT_KEY_VARIABLE = 'HOPPER_VAULT_KEY';
/** Each op is POSTed at this path plus its name. */
export const VAULT_OP_PATH = '/vault/';
/** The vault server's port in its container. */
export const VAULT_PORT = 4791;

/** The KMS's URL and its key's id or alias: runtime settings (design.md "The KMS: an optional key provider"). */
export const KMS_URL_VARIABLE = 'HOPPER_KMS_URL';
export const KMS_KEY_VARIABLE = 'HOPPER_KMS_KEY';
/** Set: the KMS is AWS KMS in this region, and HOPPER_KMS_URL, if set, its endpoint (issue #1288). */
export const KMS_REGION_VARIABLE = 'HOPPER_KMS_REGION';
/** The KMS key the vault asks for when HOPPER_KMS_KEY names none: made, with this alias, when a local KMS has none. */
export const DEFAULT_KMS_KEY = 'alias/hopper-vault';
/** The vault's KMS settings (config.ts): `region` set, AWS KMS; else the local KMS at `url`. */
export type KmsSettings = { key: string } & ({ region: string; url?: string } | { region?: undefined; url: string });

/** An AWS region's name, as `eu-west-1` or `us-gov-west-1`. */
export const AWS_REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d+$/;


const user = z.string().min(1).max(100);
const by = z.string().max(200);
const name = z.string().max(64);
const mintsFor = z.strictObject({ kind: z.enum(ASSET_KINDS), name: z.string().max(200) });

/**
 * Each op's body; the answer is `{ result, events }`. Only what needs the vault's key crosses: whether it can be used
 * (`status`), a secret set or removed, a delivery, a mint. The templates and their approvals stay in the hopper, with access.
 */
export const vaultOps = {
  status: z.strictObject({ user }),
  set: z.strictObject({ user, by, secret: z.strictObject({ name, scope: z.string().max(200).optional(), value: z.string().max(VAULT_VALUE_MAX), mints: mintsFor.nullable().optional() }) }),
  remove: z.strictObject({ user, by, name }),
  deliver: z.strictObject({
    user,
    ask: z.strictObject({ name, token: z.string().max(1000) }),
    /** The machine whose link signed the ask, as the hopper knows it; absent: no joined machine holds the key. */
    machine: z.strictObject({
      name: z.string().max(200), key: z.string().max(200), template: z.string().max(64).optional(),
      /** What a box the hopper launched was launched with (issue #708): the delivery gives it nothing else. */
      launch: z.strictObject({
        secrets: z.array(name).max(256),
        profile: z.strictObject({ operation: z.string().max(32), asset: z.strictObject({ kind: z.string().max(32), name: z.string().max(253) }) }).optional(),
      }).optional(),
    }).optional(),
    /** Whether the job's token is one the user's link key gives (issue #563): only the hopper holds that key. */
    holds: z.boolean(),
  }),
  /**
   * A Windows sandbox step's secret (issue #731): the hopper checked the job's token and the host's list; the vault checks
   * the job is at work and opens the secret.
   */
  'step-deliver': z.strictObject({ user, ask: z.strictObject({ name, job: z.string().max(64), host: z.string().max(40) }) }),
  /**
   * A mint from a minting credential (issue #580), asked only after the hopper's Access allowed it: the vault opens the
   * minting credential and calls STS or the Kubernetes API; the minted credential crosses back, the minting one never.
   */
  mint: z.strictObject({
    user,
    /** The minting credential, or (issue #1766) a cluster to find in the AWS accounts of these minting credentials. */
    credential: name.optional(),
    discover: z.strictObject({ cluster: z.string().max(100), role: z.string().max(64), credentials: z.array(z.strictObject({ name, account: z.string().max(12) })).max(100), region: z.string().max(32).optional() }).optional(),
    target: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('aws'), mintsFor: mintsFor, roleArn: z.string().max(300), policyArns: z.array(z.string().max(300)).max(10), policy: z.string().max(2048).optional(), durationSeconds: z.number().int().min(900).max(43200) }),
      z.strictObject({ kind: z.literal('kube'), mintsFor: mintsFor, namespace: z.string().max(253), serviceAccount: z.string().max(253), expirationSeconds: z.number().int().min(600).max(86400), bindTo: z.string().max(253).optional() }),
    ]),
    jobId: z.string().max(64),
    /** A mint test (issue #781): ask STS who the minted session is, at the minting credential's STS. */
    identify: z.boolean().optional(),
  }),
  /** A sandbox ended (issue #1371): the vault deletes the Secret its token is bound to, with the minting credential that made it. */
  unbind: z.strictObject({ user, binding: z.strictObject({ credential: name, namespace: z.string().max(253), secret: z.string().max(253) }) }),
  /** A launch's agent credential (issue #708, part 10): the template's checks run here too, then the value crosses back. */
  'agent-credential': z.strictObject({ user, ask: z.strictObject({ template: name, secrets: z.array(name).max(256), box: z.string().max(200) }) }),
  /** A job pod's agent credential (issue #1287): the user's own secret, checked here, then the value crosses back. */
  'pod-credential': z.strictObject({ user, ask: z.strictObject({ name, pod: z.string().max(200), job: z.string().max(64) }) }),
  /** The values of the vault secrets delivered to a job (issue #1957), read from its delivery events: its checkpoint is scrubbed of them. */
  'delivered-to': z.strictObject({ user, jobId: z.string().max(64) }),
  /**
   * A database read (issue #2231), asked only after the hopper's Access allowed it: the vault opens the database's minting
   * credential, mints a database read role, runs the SELECT and drops the role. The rows cross back, never a credential.
   */
  'database-read': z.strictObject({
    user,
    read: z.strictObject({
      job: z.string().max(64), template: name, asset: z.strictObject({ kind: z.literal('database'), name: z.string().max(200) }),
      sql: z.string().max(SQL_MAX), id: z.string().regex(/^[0-9a-f]{16}$/), decision: z.string().max(100),
    }),
  }),
  /** Drops each database read role past its TTL (issue #2231), in each database a minting credential the vault holds mints for. */
  'database-sweep': z.strictObject({ user }),
} as const;

export type VaultOp = keyof typeof vaultOps;
