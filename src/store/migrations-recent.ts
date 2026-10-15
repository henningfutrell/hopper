// The instance migrations from 37 on: migrations.ts puts them at the end of its list (MIGRATIONS), so that list stays
// under the file-size limit. A new instance migration is appended here: its import on a line of its own after the others,
// and its entry after the last, its comment above it.
// Numbers are given out at merge time (issue #967): the base branch marks this file `hopper-merge=additions`
// (.gitattributes), so when two pull requests each append a migration, the hopper's base merge keeps both, the base
// branch's first, with no job. The place in the list is the version; the number in a comment is the one its author saw.
import type { Migration } from './migrations.ts';
import { remoteAccessProvider } from './migration-remote-access.ts';

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
];
