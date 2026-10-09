// The vault container's wire (issue #586, design.md "The vault in a container of its own"): what the hopper sends the
// vault server, and the names both sides read. One POST per edit or ask, JSON, with the preshared key as a bearer token.
import { z } from 'zod';
import { VAULT_VALUE_MAX } from '../domain/vault.ts';

/** The preshared key the hopper shows and the vault checks: a runtime secret (also `_FILE`). */
export const VAULT_KEY_VARIABLE = 'HOPPER_VAULT_KEY';
/** Each op is POSTed at this path plus its name. */
export const VAULT_OP_PATH = '/vault/';
/** The vault server's port in its container. */
export const VAULT_PORT = 4791;

/** The KMS's URL and its key's id or alias: runtime settings (design.md "The KMS: an optional key provider"). */
export const KMS_URL_VARIABLE = 'HOPPER_KMS_URL';
export const KMS_KEY_VARIABLE = 'HOPPER_KMS_KEY';
/** The KMS key the vault asks for when HOPPER_KMS_KEY names none: made, with this alias, when the KMS has none. */
export const DEFAULT_KMS_KEY = 'alias/hopper-vault';

const user = z.string().min(1).max(100);
const by = z.string().max(200);
const name = z.string().max(64);

/** Each op's body; the answer is `{ result, events }`. */
export const vaultOps = {
  view: z.strictObject({ user }),
  set: z.strictObject({ user, by, secret: z.strictObject({ name, scope: z.string().max(200).optional(), value: z.string().max(VAULT_VALUE_MAX) }) }),
  remove: z.strictObject({ user, by, name }),
  'save-template': z.strictObject({ user, by, template: z.strictObject({ name, image: z.string().max(300), secrets: z.array(name).max(256) }) }),
  'remove-template': z.strictObject({ user, by, name }),
  'approve-template': z.strictObject({ user, by, name }),
  deliver: z.strictObject({
    user,
    ask: z.strictObject({ name, token: z.string().max(1000) }),
    /** The machine whose link signed the ask, as the hopper knows it; absent: no joined machine holds the key. */
    machine: z.strictObject({ name: z.string().max(200), key: z.string().max(200), template: z.string().max(64).optional() }).optional(),
    /** Whether the job's token is one the user's link key gives (issue #563): only the hopper holds that key. */
    holds: z.boolean(),
  }),
} as const;

export type VaultOp = keyof typeof vaultOps;
