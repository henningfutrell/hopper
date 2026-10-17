// The instance migrations from 37 on: migrations.ts puts them at the end of its list (MIGRATIONS), so that list stays
// under the file-size limit. A new instance migration is appended here: its import on a line of its own after the others,
// and its entry after the last, its comment above it.
// Numbers are given out at merge time (issue #967): the base branch marks this file `hopper-merge=additions`
// (.gitattributes), so when two pull requests each append a migration, the hopper's base merge keeps both, the base
// branch's first, with no job. The place in the list is the version; the number in a comment is the one its author saw.
import type { Migration } from './migrations.ts';
import { remoteAccessProvider } from './migration-remote-access.ts';
import { SANDBOX_RUN_TABLE } from './sandbox-runs.ts';
import { cloudLinkInstanceId } from './migration-cloud-link-id.ts';
import { SAGA_TABLE } from './sagas.ts';
import { NEED_STEP_TABLE } from './need-steps.ts';
import { WINDOWS_STEP_TABLE } from './windows-steps.ts';
import { SWEEP_LEASE_TABLE } from './sweep-leases.ts';
import { OUTBOUND_KEY_TABLE } from './outbound-keys.ts';

export const RECENT_INSTANCE_MIGRATIONS: readonly Migration[] = [
  // 37: grants (issue #881): a grant a person minted for an agent, its refresh tokens (only their hashes; a rotated one
  // kept for reuse detection), and the grant each API token was refreshed from. Tables and a column only: the build
  // before never reads them, and reads such an API token as one of its own until it ends (15 minutes at most).
  'CREATE TABLE IF NOT EXISTS api_grants (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS api_grant_tokens (token_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, issued_at TEXT NOT NULL, rotated_at TEXT); CREATE INDEX IF NOT EXISTS api_grant_tokens_grant ON api_grant_tokens (grant_id); ALTER TABLE ui_sessions ADD COLUMN grant_id TEXT;',
  // 38: the stack's resources over time (issue #947): one stack sample per service, metric and time. A table only: the
  // build before never reads it.
  'CREATE TABLE IF NOT EXISTS stack_samples (at TIMESTAMPTZ NOT NULL, service TEXT NOT NULL, metric TEXT NOT NULL, grp TEXT NOT NULL, value DOUBLE PRECISION NOT NULL, PRIMARY KEY (service, metric, at)); CREATE INDEX IF NOT EXISTS stack_samples_at ON stack_samples (at);',
  // 39: remote access names its provider (issue #968). A record from before is ngrok's, and its domain is the one its
  // tunnel runs at, with the authtoken given by hand: `provisioned`, which the hopper keeps when remote access is turned
  // off (it minted none of it). The build before reads `enabled` and `domain` only, as before.
  remoteAccessProvider,
  // 40: a join code names the job pod the hopper started with it (issue #1283). A column only: the build before never
  // reads it, and joins such a pod as a plain client target.
  'ALTER TABLE join_codes ADD COLUMN IF NOT EXISTS pod TEXT;',
  // 41: local accounts (issue #1380): the hopper's own email and password sign-in, a scrypt hash per account. A table only:
  // the build before never reads it, and signs nobody in with it.
  'CREATE TABLE IF NOT EXISTS local_accounts (email TEXT PRIMARY KEY, password_hash TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL);',
  // 42: the sandbox runs (issue #1349): one row per sandbox made for a step, from its start to its burn. A table only:
  // the build before never reads it.
  SANDBOX_RUN_TABLE,
  // 43: identity keyed by email (issue #1380): a user keeps the verified email it is known by, unique among the users. A
  // user a local account signed in as takes that account's email, its subject; any other user takes one at its next
  // sign-in. A column only: the build before never reads it, and inserts its users with none.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT; CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users (lower(email));
   UPDATE users SET email = f.subject FROM (SELECT DISTINCT ON (user_id) user_id, subject FROM user_identities WHERE realm = 'local-accounts' ORDER BY user_id, subject) f
   WHERE f.user_id = users.id AND users.email IS NULL;`,
  // 44: passkeys for local accounts (issue #1380): one row per WebAuthn credential, its public key, the host name it was
  // added at and its signature counter; an account's removal removes its passkeys. A table only: the build before never
  // reads it, and signs nobody in with it.
  'CREATE TABLE IF NOT EXISTS local_account_passkeys (id TEXT PRIMARY KEY, email TEXT NOT NULL REFERENCES local_accounts (email) ON DELETE CASCADE, rp_id TEXT NOT NULL, public_key TEXT NOT NULL, counter BIGINT NOT NULL, transports TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT); CREATE INDEX IF NOT EXISTS local_account_passkeys_email ON local_account_passkeys (email);',
  // 45: the cloud link's id is the instance id (issue #465), so a link again is the same instance at hopper.io. A record
  // from before takes it; the build before reads `installId` as before.
  cloudLinkInstanceId,
  // 46: the sagas (issue #1524): one row per saga, its steps and data as JSON, its lease and abort as columns. A table
  // only: the build before never reads it, and leaves a saga to a hopper that knows its kind.
  SAGA_TABLE,
  // 47: the need steps (issue #1568): one row per need step or box step, its ask, inputs, log, result and outputs. A
  // table only: the build before never reads it, and keeps its steps in memory as before.
  NEED_STEP_TABLE,
  // 48: spent join codes (issue #1628): a join code, once spent, is kept with the machine key that spent it until it
  // expires, so that machine's join sent again is answered as the first. A table only: the build before never reads it,
  // and takes no spent code again.
  'CREATE TABLE IF NOT EXISTS join_codes_spent (code_hash TEXT PRIMARY KEY, machine_key TEXT NOT NULL, expires_at TEXT NOT NULL, user_id TEXT NOT NULL, template TEXT, pod TEXT);',
  // 49: the Windows steps (issue #1611): one row per Windows sandbox step, its ask, inputs, log, result, outputs and the
  // hold of its host. A table only: the build before never reads it, and keeps its steps in memory as before.
  WINDOWS_STEP_TABLE,
  // 50: two hosts on one database (issue #1627): the sweep leases, one host's hold on each sweep, and the outbound dedupe
  // keys. Tables only: the build before never reads them, and runs its sweeps and dedupes its sends in memory as before.
  SWEEP_LEASE_TABLE + OUTBOUND_KEY_TABLE,
  // 51: lane pool keys the hopper issues (issue #1454): one per user at most, only its SHA-256 kept, for lane pods of a
  // chart release outside this hopper's own. A table only: the build before never reads it, and joins no pod with one.
  'CREATE TABLE IF NOT EXISTS lane_pool_keys (key_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS lane_pool_keys_user ON lane_pool_keys (user_id);',
];
