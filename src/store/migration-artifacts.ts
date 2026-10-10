// Tenant migration 34 (issue #624, design.md "Artifacts"): the artifacts jobs make for a person to see, their content
// in the database, and their shares. Tables only: the build before runs on them.
export const ARTIFACT_TABLES = `
  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    issue_url TEXT,
    issue_ref TEXT,
    title TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    size BIGINT NOT NULL,
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    content BYTEA NOT NULL
  );
  CREATE INDEX artifacts_job ON artifacts (job_id, created_at);
  CREATE INDEX artifacts_created ON artifacts (created_at);
  CREATE TABLE artifact_shares (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifacts (id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    user_id TEXT,
    user_name TEXT,
    token_hash TEXT UNIQUE,
    expires_at TEXT,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    revoked_at TEXT,
    revoked_by TEXT
  );
  CREATE INDEX artifact_shares_artifact ON artifact_shares (artifact_id)`;
